/**
 * Blob Storage Manager for Vercel Blob & Local File Fallback
 * 
 * Production mode (Vercel):
 * When BLOB_READ_WRITE_TOKEN is set in environment (automatically injected by Vercel Blob Store):
 * Uses official @vercel/blob SDK (put, list, del).
 * 
 * Fallback mode (Local or Token-less):
 * Reads from bundled ./data/ directory or writes to /tmp/data (read-only filesystem safe).
 */

import fs from "fs";
import path from "path";
import { put, list, del } from "@vercel/blob";

const LOCAL_DATA_DIR = path.resolve(process.cwd(), "data");
const TMP_DATA_DIR = path.resolve("/tmp", "data");

function getWritableDir() {
  try {
    if (!fs.existsSync(LOCAL_DATA_DIR)) {
      fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
    }
    // Test write permission
    const testFile = path.join(LOCAL_DATA_DIR, ".write_test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
    return LOCAL_DATA_DIR;
  } catch {
    // Read-only filesystem (e.g. AWS Lambda / Vercel Serverless runtime)
    try {
      if (!fs.existsSync(TMP_DATA_DIR)) {
        fs.mkdirSync(TMP_DATA_DIR, { recursive: true });
      }
      return TMP_DATA_DIR;
    } catch {
      return "/tmp";
    }
  }
}

/**
 * Save media record to Blob Storage (or local /tmp fallback)
 * @param {string} id - Media ID (e.g. "6672")
 * @param {object} data - Full JSON payload
 */
export async function saveMedia(id, data) {
  if (!id) throw new Error("Missing media id");
  const filename = `media_${id}.json`;
  const content = JSON.stringify(data, null, 2);

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    try {
      const blob = await put(filename, content, {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
        token,
      });
      return { storage: "vercel-blob", id, url: blob.url };
    } catch (err) {
      console.warn("Vercel Blob put error, falling back to disk:", err.message);
    }
  }

  // Fallback to writable directory
  const targetDir = getWritableDir();
  const filePath = path.join(targetDir, filename);
  fs.writeFileSync(filePath, content, "utf-8");
  return { storage: "local", id, file: filePath };
}

/**
 * Get media record by ID
 * @param {string} id - Media ID (e.g. "6672")
 */
export async function getMedia(id) {
  if (!id) return null;
  const filename = `media_${id}.json`;
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (token) {
    try {
      const result = await list({ prefix: filename, token });
      const found = (result.blobs || []).find(
        (b) => b.pathname === filename || b.pathname.endsWith("/" + filename)
      );
      if (found) {
        const fetchUrl = found.downloadUrl || found.url;
        const res = await fetch(fetchUrl);
        if (res.ok) {
          return await res.json();
        }
      }
    } catch (e) {
      console.warn("Vercel Blob get error, trying disk fallback:", e.message);
    }
  }

  // Check bundled repo data dir first
  const repoPath = path.join(LOCAL_DATA_DIR, filename);
  if (fs.existsSync(repoPath)) {
    try {
      return JSON.parse(fs.readFileSync(repoPath, "utf-8"));
    } catch {}
  }

  // Check /tmp data dir
  const tmpPath = path.join(TMP_DATA_DIR, filename);
  if (fs.existsSync(tmpPath)) {
    try {
      return JSON.parse(fs.readFileSync(tmpPath, "utf-8"));
    } catch {}
  }

  return null;
}

/**
 * List all saved media records
 */
export async function listMedia() {
  const items = [];
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (token) {
    try {
      const result = await list({ prefix: "media_", token });
      for (const blob of result.blobs || []) {
        const idMatch = blob.pathname.match(/media_([a-zA-Z0-9_-]+)\.json$/);
        if (idMatch) {
          items.push({
            id: idMatch[1],
            pathname: blob.pathname,
            url: blob.url,
            downloadUrl: blob.downloadUrl,
            uploadedAt: blob.uploadedAt,
            size: blob.size,
            storage: "vercel-blob",
          });
        }
      }
      if (items.length > 0) return items;
    } catch (e) {
      console.warn("Vercel Blob list error, checking disk fallback:", e.message);
    }
  }

  // Disk fallback (check both LOCAL_DATA_DIR and TMP_DATA_DIR)
  const seenIds = new Set();
  for (const dir of [LOCAL_DATA_DIR, TMP_DATA_DIR]) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const idMatch = f.match(/^media_([a-zA-Z0-9_-]+)\.json$/);
          if (idMatch && !seenIds.has(idMatch[1])) {
            seenIds.add(idMatch[1]);
            try {
              const content = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
              items.push({
                id: idMatch[1],
                title: content.title || "Untitled",
                updatedAt: fs.statSync(path.join(dir, f)).mtime,
                storage: "local",
              });
            } catch {}
          }
        }
      } catch {}
    }
  }

  return items;
}

/**
 * Delete a media record by ID
 * @param {string} id - Media ID
 */
export async function deleteMedia(id) {
  if (!id) return false;
  const filename = `media_${id}.json`;
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (token) {
    try {
      const result = await list({ prefix: filename, token });
      const urls = (result.blobs || []).map((b) => b.url);
      if (urls.length > 0) {
        await del(urls, { token });
      }
    } catch (e) {
      console.warn("Vercel Blob delete error:", e.message);
    }
  }

  for (const dir of [LOCAL_DATA_DIR, TMP_DATA_DIR]) {
    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }
  }

  return true;
}
