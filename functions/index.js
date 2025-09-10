const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {Storage} = require("@google-cloud/storage");
const AdmZip = require("adm-zip");
const cors = require("cors")({origin: true});
const os = require("os");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const Busboy = require("busboy");

admin.initializeApp();
const storage = new Storage();

const TEMPLATE_BUCKET = "hash2app-templates";
const BUILDS_BUCKET = "hash2app-builds";

// Helper function to resize and create all necessary app icons
const createAppIcons = async (imageBuffer, outputDir) => {
  const SIZES = [
    {size: 1024, name: "icon-1024.png"},
    {size: 512, name: "icon-512.png"},
    {size: 192, name: "icon-192.png"},
  ];
  await fs.promises.mkdir(outputDir, {recursive: true});
  for (const s of SIZES) {
    await sharp(imageBuffer)
        .resize(s.size, s.size)
        .toFile(path.join(outputDir, s.name));
  }
};


exports.buildAppV2 = functions.runWith({
  timeoutSeconds: 300,
  memory: "1GB",
}).https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    // eslint-disable-next-line new-cap
    const busboy = Busboy({headers: req.headers});
    const tmpdir = os.tmpdir();
    const fields = {};
    const uploads = {};

    busboy.on("field", (fieldname, val) => {
      fields[fieldname] = val;
    });

    busboy.on("file", (fieldname, file, {filename}) => {
      const filepath = path.join(tmpdir, filename);
      uploads[fieldname] = {filepath, file};
      file.pipe(fs.createWriteStream(filepath));
    });

    busboy.on("finish", async () => {
      try {
        const {url, appName} = fields;
        const iconFile = uploads.icon;

        if (!url || !appName) {
          return res.status(400).send("Missing URL or App Name.");
        }

        const tempDir = os.tmpdir();
        const templateZipPath = path.join(tempDir, "capacitor-template.zip");
        const extractionPath = path.join(tempDir, "extracted");

        await storage.bucket(TEMPLATE_BUCKET)
            .file("capacitor-template.zip")
            .download({destination: templateZipPath});

        const zip = new AdmZip(templateZipPath);
        zip.extractAllTo(extractionPath, true);

        const templateFolderPath = path
            .join(extractionPath, "capacitor-template");
        const configPath = path
            .join(templateFolderPath, "capacitor.config.json");
        const iconsPath = path.join(templateFolderPath, "www", "icons");


        if (iconFile) {
          const iconBuffer = fs.readFileSync(iconFile.filepath);
          await createAppIcons(iconBuffer, iconsPath);
        }

        const configFile = fs.readFileSync(configPath, "utf8");
        const config = JSON.parse(configFile);
        config.appName = appName;
        config.server.url = url;

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        const newZip = new AdmZip();
        newZip.addLocalFolder(templateFolderPath);
        const newZipPath = path.join(tempDir, `${appName}.zip`);
        newZip.writeZip(newZipPath);

        const destFileName = `builds/${appName}-${Date.now()}.zip`;
        await storage.bucket(BUILDS_BUCKET).upload(newZipPath, {
          destination: destFileName,
        });

        const options = {
          version: "v4",
          action: "read",
          expires: Date.now() + 15 * 60 * 1000,
        };
        const [signedUrl] = await storage
            .bucket(BUILDS_BUCKET)
            .file(destFileName)
            .getSignedUrl(options);

        res.status(200).send({downloadUrl: signedUrl});
      } catch (error) {
        console.error("Build failed:", error);
        res.status(500).send("Could not build app.");
      }
    });

    busboy.end(req.rawBody);
  });
});

