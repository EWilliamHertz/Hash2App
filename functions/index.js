const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {Storage} = require("@google-cloud/storage");
const AdmZip = require("adm-zip");
const cors = require("cors")({origin: true});
const os = require("os");
const path = require("path");
const fs = require("fs");

admin.initializeApp();
const storage = new Storage();

// --- Configuration: REPLACE with your bucket names ---
const TEMPLATE_BUCKET = "hash2app-templates";
const BUILDS_BUCKET = "hash2app-builds";

exports.buildApp = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    try {
      const {url, name: appName} = req.body;

      if (!url || !appName) {
        return res.status(400)
            .send("Missing `url` or `name` in request body.");
      }

      const tempDir = os.tmpdir();
      const templateZipPath = path.join(tempDir, "capacitor-template.zip");
      const extractionPath = path.join(tempDir, "extracted");

      await storage.bucket(TEMPLATE_BUCKET)
          .file("capacitor-template.zip")
          .download({destination: templateZipPath});

      const zip = new AdmZip(templateZipPath);
      zip.extractAllTo(extractionPath, true);

      const templateFolderPath =
        path.join(extractionPath, "capacitor-template");
      const configPath =
        path.join(templateFolderPath, "capacitor.config.json");

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
        expires: Date.now() + 15 * 60 * 1000, // 15 minutes
      };
      const [signedUrl] = await storage
          .bucket(BUILDS_BUCKET)
          .file(destFileName)
          .getSignedUrl(options);

      res.status(200).send({downloadUrl: signedUrl});
    } catch (error) {
      console.error("Build failed:", error);
      res.status(500).send("Internal Server Error: Could not build the app.");
    }
  });
});

