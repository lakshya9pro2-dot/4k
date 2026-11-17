/**
 * HubCloud Extractor - Universal Vercel Worker / Serverless Function
 * Ported from CloudStream's HubCloud.kt
 *
 * Compatible with:
 * - Vercel Serverless (Node.js runtime)
 * - Vercel Edge Functions (Edge runtime)
 * - Cloudflare Workers
 * - Standalone Node.js script / CLI
 */

import { saveMedia, getMedia, listMedia, deleteMedia } from "./blob-storage.js";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "9310081539";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Clean release title details (ported from HubCloud.kt cleanTitle)
 */
function cleanTitle(title) {
  if (!title) return "";
  const parts = title.split(/[.\-_]/);

  const qualityTags = [
    "WEBRip", "WEB-DL", "WEB", "BluRay", "HDRip", "DVDRip", "HDTV",
    "CAM", "TS", "R5", "DVDScr", "BRRip", "BDRip", "DVD", "PDTV", "HD"
  ];
  const audioTags = [
    "AAC", "AC3", "DTS", "MP3", "FLAC", "DD5", "EAC3", "Atmos"
  ];
  const subTags = [
    "ESub", "ESubs", "Subs", "MultiSub", "NoSub", "EnglishSub", "HindiSub"
  ];
  const codecTags = ["x264", "x265", "H264", "HEVC", "AVC"];

  const startIndex = parts.findIndex((part) =>
    qualityTags.some((tag) => part.toLowerCase().includes(tag.toLowerCase()))
  );

  let endIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (
      subTags.some((t) => part.toLowerCase().includes(t.toLowerCase())) ||
      audioTags.some((t) => part.toLowerCase().includes(t.toLowerCase())) ||
      codecTags.some((t) => part.toLowerCase().includes(t.toLowerCase()))
    ) {
      endIndex = i;
      break;
    }
  }

  if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
    return parts.slice(startIndex, endIndex + 1).join(".");
  } else if (startIndex !== -1) {
    return parts.slice(startIndex).join(".");
  } else {
    return parts.slice(-3).join(".");
  }
}

/**
 * Extract quality integer (e.g. 1080 from "1080p")
 */
function getIndexQuality(str) {
  if (!str) return 1080;
  const match = str.match(/(\d{3,4})[pP]/);
  return match ? parseInt(match[1], 10) : 1080;
}

/**
 * Safe Base64 encoder (UTF-8 safe)
 */
function toBase64(str) {
  if (!str) return "";
  return Buffer.from(str, "utf-8").toString("base64");
}

/**
 * Safely resolve relative URLs
 */
function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

/**
 * Core HubCloud extraction function
 * @param {string} inputUrl - HubCloud Drive URL, HubCloud ID, or hubcloud.php link
 */
async function extractHubCloud(inputUrl) {
  if (!inputUrl || typeof inputUrl !== "string") {
    throw new Error("Missing or invalid 'url' parameter");
  }

  let realUrl = inputUrl.trim();

  // If input is just an ID (e.g. "ciudcwrxjfchbsh")
  if (/^[a-zA-Z0-9_-]+$/.test(realUrl)) {
    realUrl = `https://hubcloud.mov/drive/${realUrl}`;
  } else if (!realUrl.startsWith("http://") && !realUrl.startsWith("https://")) {
    realUrl = `https://${realUrl}`;
  }

  let href = "";
  let baseUrl = "";
  try {
    const parsed = new URL(realUrl);
    baseUrl = `${parsed.protocol}//${parsed.host}`;
  } catch (e) {
    throw new Error(`Invalid URL: ${realUrl}`);
  }

  // 1. Get intermediate hubcloud.php link
  if (realUrl.includes("hubcloud.php")) {
    href = realUrl;
  } else {
    const pageResp = await fetch(realUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
    });

    if (!pageResp.ok) {
      throw new Error(
        `Failed to fetch drive page (${pageResp.status} ${pageResp.statusText})`
      );
    }

    const pageHtml = await pageResp.text();

    // Look for <a id="download" href="..."> or <a href="..." id="download">
    const match =
      pageHtml.match(/id=["']download["'][^>]*href=["']([^"']+)["']/i) ||
      pageHtml.match(/href=["']([^"']+)["'][^>]*id=["']download["']/i);

    if (match && match[1]) {
      href = match[1].trim();
      if (!href.startsWith("http://") && !href.startsWith("https://")) {
        href = resolveUrl(baseUrl, href);
      }
    } else {
      // Fallback: look for generate direct download link button
      const linkMatch = pageHtml.match(
        /href=["'](https?:\/\/[^"']*hubcloud\.php[^"']*)["']/i
      );
      if (linkMatch && linkMatch[1]) {
        href = linkMatch[1];
      }
    }
  }

  if (!href) {
    throw new Error("Could not find direct download landing page (href)");
  }

  // 2. Fetch the hubcloud.php landing page
  const hubResp = await fetch(href, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: realUrl,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    },
  });

  if (!hubResp.ok) {
    throw new Error(
      `Failed to fetch download page (${hubResp.status} ${hubResp.statusText})`
    );
  }

  const hubHtml = await hubResp.text();

  // 3. Extract Metadata
  const headerMatch = hubHtml.match(
    /<div[^>]*class=["'][^"']*card-header[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  );
  const sizeMatch = hubHtml.match(
    /<i[^>]*id=["']size["'][^>]*>([\s\S]*?)<\/i>/i
  );

  const rawHeader = headerMatch
    ? headerMatch[1].replace(/<[^>]+>/g, "").trim()
    : "";
  const rawSize = sizeMatch ? sizeMatch[1].replace(/<[^>]+>/g, "").trim() : "";

  const titleDetails = cleanTitle(rawHeader);
  const quality = getIndexQuality(rawHeader);

  // 4. Extract all button links
  const btnRegex =
    /<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*btn[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let btnMatch;
  const rawButtons = [];

  while ((btnMatch = btnRegex.exec(hubHtml)) !== null) {
    const link = btnMatch[1].trim();
    const text = btnMatch[2].replace(/<[^>]+>/g, "").trim();
    rawButtons.push({ text, link });
  }

  // If no buttons via class="btn", try generic a tags in card-body
  if (rawButtons.length === 0) {
    const cardBodyMatch = hubHtml.match(
      /<div[^>]*class=["'][^"']*card-body[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );
    if (cardBodyMatch) {
      const genericRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let gMatch;
      while ((gMatch = genericRegex.exec(cardBodyMatch[1])) !== null) {
        const link = gMatch[1].trim();
        const text = gMatch[2].replace(/<[^>]+>/g, "").trim();
        if (link && text) rawButtons.push({ text, link });
      }
    }
  }

  // 5. Categorize and resolve stream links (ported from HubCloud.kt)
  const streams = [];

  for (const item of rawButtons) {
    const { text, link } = item;
    const lower = text.toLowerCase();

    // 1. Skip 10Gbps completely: "dont even use 10Gbps"
    if (lower.includes("10gbps") || link.includes("gpdl.hubcloud")) {
      continue;
    }

    // 2. T3 Server: "if have t3 T3 Server then get link"
    if (
      lower.includes("t3 server") ||
      lower.includes("[t3") ||
      lower === "t3" ||
      link.includes("t3dl.php")
    ) {
      let t3DirectUrl = link;
      try {
        const t3Resp = await fetch(link, {
          method: "GET",
          headers: {
            "User-Agent": USER_AGENT,
            Referer: href,
            Range: "bytes=0-10",
          },
          redirect: "manual",
        });
        const loc = t3Resp.headers.get("location");
        if (loc) {
          t3DirectUrl = loc;
        }
      } catch (err) {
        console.warn("Could not resolve T3 redirect:", err.message);
      }

      streams.push({
        name: "T3 Server",
        url: t3DirectUrl,
        server: "T3 Server",
        quality: `${quality}p`,
        format: t3DirectUrl.includes(".mkv") ? "mkv" : "mp4",
        type: t3DirectUrl.includes(".mkv") ? "video/x-matroska" : "video/mp4",
        recommended: true,
      });
      continue;
    }

    // 3. Watch Online: "copy full link https://hbplay.pages.dev/?u=... and remove https://hbplay.pages.dev/?u= and then decode it base64 and get full url"
    if (lower.includes("watch online")) {
      let decodedUrl = "";
      try {
        let uParam = "";
        if (link.includes("?u=") || link.includes("&u=")) {
          const matchU = link.match(/[?&]u=([^&]+)/);
          if (matchU && matchU[1]) {
            uParam = decodeURIComponent(matchU[1]);
          }
        } else if (link.startsWith("https://hbplay.pages.dev/?u=")) {
          uParam = link.replace("https://hbplay.pages.dev/?u=", "").split("&")[0];
        }

        if (uParam) {
          decodedUrl = Buffer.from(uParam, "base64").toString("utf-8");
        }
      } catch (e) {
        console.warn("Could not decode Watch Online u param:", e.message);
      }

      if (decodedUrl) {
        streams.push({
          name: "Watch Online (Direct Stream)",
          url: decodedUrl,
          originalWatchUrl: link,
          server: "Watch Online",
          quality: `${quality}p`,
          format: decodedUrl.includes(".mkv") ? "mkv" : "mp4",
          type: decodedUrl.includes(".mkv") ? "video/x-matroska" : "video/mp4",
        });
      }
      continue;
    }

    // 4. FSLv2 Server
    if (lower.includes("fslv2")) {
      streams.push({
        name: "FSLv2 Server",
        url: link,
        server: "FSLv2",
        quality: `${quality}p`,
        format: link.includes(".mkv") ? "mkv" : "mp4",
        type: link.includes(".mkv") ? "video/x-matroska" : "video/mp4",
      });
      continue;
    }

    // 5. FSL Server (Cloudflare R2 direct stream URL)
    if (lower.includes("fsl server") || lower.includes("fsl")) {
      streams.push({
        name: "FSL Server",
        url: link,
        server: "FSL Server",
        quality: `${quality}p`,
        format: link.includes(".mkv") ? "mkv" : "mp4",
        type: link.includes(".mkv") ? "video/x-matroska" : "video/mp4",
        recommended: !streams.some((s) => s.name === "T3 Server"),
      });
      continue;
    }

    // 6. Download File / Direct S3
    if (lower.includes("download file")) {
      streams.push({
        name: "Download File",
        url: link,
        server: "Direct",
        quality: `${quality}p`,
        format: "mp4",
        type: "video/mp4",
      });
      continue;
    }

    // 7. BuzzServer / Buzz Server
    if (lower.includes("buzzserver") || lower.includes("buzz server")) {
      streams.push({
        name: "BuzzServer",
        url: link,
        server: "BuzzServer",
        quality: `${quality}p`,
      });
      continue;
    }

    // 8. PixelDrain / PixelServer
    if (lower.includes("pixel")) {
      let finalPixelUrl = link;
      try {
        const pUrl = new URL(link);
        const fileId = pUrl.pathname.split("/").filter(Boolean).pop();
        if (fileId && !link.includes("download")) {
          finalPixelUrl = `https://pixeldrain.com/api/file/${fileId}?download`;
        }
      } catch {}
      streams.push({
        name: "PixelDrain",
        url: finalPixelUrl,
        originalUrl: link,
        server: "PixelDrain",
        quality: `${quality}p`,
      });
      continue;
    }

    // 9. S3 Server
    if (lower.includes("s3 server")) {
      streams.push({
        name: "S3 Server",
        url: link,
        server: "S3 Server",
        quality: `${quality}p`,
      });
      continue;
    }

    // 10. Mega Server
    if (lower.includes("mega server")) {
      streams.push({
        name: "Mega Server",
        url: link,
        server: "Mega Server",
        quality: `${quality}p`,
      });
      continue;
    }
  }

  // Best stream selection priority: T3 Server > FSLv2 > Watch Online > FSL Server > Others
  const primaryStream = selectBestStream(streams);

  // Build HDHub Player launch URL (with quality options if multiple servers exist)
  let playerUrl = "";
  if (primaryStream) {
    const encodedU = toBase64(primaryStream.url);
    const encodedM = toBase64(primaryStream.type || "video/x-matroska");
    const encodedT = toBase64(rawHeader || "HubCloud Video");
    playerUrl = `/player.html?u=${encodeURIComponent(encodedU)}&m=${encodeURIComponent(encodedM)}&t=${encodeURIComponent(encodedT)}`;

    // Add alternate streams to player qualities
    const altStreams = streams.filter(
      (s) => s.url && s.url !== primaryStream.url && (s.type || s.format)
    );
    altStreams.slice(0, 4).forEach((alt, idx) => {
      const qNum = idx + 2;
      playerUrl += `&q${qNum}=${encodeURIComponent(toBase64(alt.url))}`;
      playerUrl += `&q${qNum}_label=${encodeURIComponent(toBase64(alt.name))}`;
    });
  }

  return {
    success: true,
    title: rawHeader,
    size: rawSize,
    quality: quality,
    details: titleDetails,
    landingUrl: href,
    streamCount: streams.length,
    primaryStream,
    streams,
    playerUrl,
  };
}

/**
 * Select the single best stream per user priority:
 * 1. T3 Server
 * 2. FSLv2 Server
 * 3. Watch Online (Direct Stream decoded from hbplay.pages.dev)
 * 4. FSL Server
 * 5. Fallback to any direct stream
 */
function selectBestStream(streams) {
  if (!streams || streams.length === 0) return null;

  // 1. T3 Server
  const t3 = streams.find((s) => s.name === "T3 Server");
  if (t3 && t3.url) return { ...t3, priority: 1, reason: "T3 Server" };

  // 2. FSLv2 Server
  const fslv2 = streams.find((s) => s.name === "FSLv2 Server" || s.name === "FSLv2");
  if (fslv2 && fslv2.url) return { ...fslv2, priority: 2, reason: "FSLv2 Server" };

  // 3. Watch Online (Direct Stream)
  const watchOnline = streams.find(
    (s) => s.name.includes("Watch Online") && !s.url.includes("hbplay.pages.dev")
  );
  if (watchOnline && watchOnline.url)
    return { ...watchOnline, priority: 3, reason: "Watch Online (Direct Stream)" };

  // 4. FSL Server
  const fsl = streams.find((s) => s.name === "FSL Server" || s.name === "FSL");
  if (fsl && fsl.url) return { ...fsl, priority: 4, reason: "FSL Server" };

  // 5. Fallback to any other direct video stream
  const fallback = streams.find(
    (s) => s.url && (s.type === "video/x-matroska" || s.type === "video/mp4" || s.url.startsWith("https://"))
  );
  if (fallback) return { ...fallback, priority: 5, reason: "Fallback Direct Stream" };

  return streams[0] || null;
}

/**
 * Parallel Multi-Quality Resolver
 * Resolves an array of { tag, id/url } concurrently in parallel
 * and applies the priority fallback per quality.
 *
 * Example:
 * [
 *   { "tag": "4K HDR", "id": "6rd1fa6fy66761f" },
 *   { "tag": "1080p", "id": "ciudcwrxjfchbsh" }
 * ]
 */
async function resolveQualities(qualitiesList, customTitle = "") {
  if (!Array.isArray(qualitiesList) || qualitiesList.length === 0) {
    throw new Error("Missing or invalid 'qualities' array in request body");
  }

  // Resolve all qualities in parallel
  const resolvedItems = await Promise.all(
    qualitiesList.map(async (item) => {
      const tag = item.tag || item.name || item.quality || "Quality";
      const target = item.id || item.url;
      if (!target) {
        return {
          tag,
          error: "Missing 'id' or 'url'",
          resolved: false,
        };
      }

      try {
        const result = await extractHubCloud(target);
        const best = selectBestStream(result.streams);
        if (!best || !best.url) {
          return {
            tag,
            id: item.id || target,
            error: "No matching direct stream found",
            resolved: false,
          };
        }

        return {
          tag,
          id: item.id || target,
          server: best.name,
          priority: best.priority,
          url: best.url,
          type: best.type || (best.url.includes(".mkv") ? "video/x-matroska" : "video/mp4"),
          title: result.title,
          size: result.size,
          resolved: true,
        };
      } catch (err) {
        return {
          tag,
          id: item.id || target,
          error: err.message || "Extraction failed",
          resolved: false,
        };
      }
    })
  );

  const successful = resolvedItems.filter((item) => item.resolved && item.url);
  if (successful.length === 0) {
    return {
      success: false,
      error: "Could not resolve any of the specified qualities",
      items: resolvedItems,
    };
  }

  // Final title
  const finalTitle = customTitle || successful[0].title || "HubCloud Video";
  const primary = successful[0];

  // Build the complete HDHub Player launch URL
  const encodedU = toBase64(primary.url);
  const encodedM = toBase64(primary.type || "video/x-matroska");
  const encodedT = toBase64(finalTitle);

  let playerUrl = `/player.html?u=${encodeURIComponent(encodedU)}&m=${encodeURIComponent(encodedM)}&t=${encodeURIComponent(encodedT)}`;

  // Bind each quality to q1, q2, q3...
  successful.forEach((item, index) => {
    const qNum = index + 1;
    playerUrl += `&q${qNum}=${encodeURIComponent(toBase64(item.url))}`;
    playerUrl += `&q${qNum}_label=${encodeURIComponent(toBase64(item.tag))}`;
  });

  return {
    success: true,
    title: finalTitle,
    qualitiesCount: successful.length,
    qualities: successful,
    failed: resolvedItems.filter((item) => !item.resolved),
    playerUrl,
  };
}

/**
 * Resolve Stored Media Record by ID (e.g. "6672")
 * Resolves all its HubCloud qualities in parallel according to fallback priority,
 * gathers audioTracks and subtitleTracks, and builds the full player URL.
 */
export async function resolveMediaRecord(mediaId) {
  const record = await getMedia(mediaId);
  if (!record) {
    throw new Error(`Media record with id "${mediaId}" not found in Blob storage`);
  }

  const title = record.title || "Video";
  const mimeType = record.mimeType || "video/x-matrosk";

  // 1. Resolve qualities
  let qualitiesList = [];
  if (Array.isArray(record.qualities) && record.qualities.length > 0) {
    const validQualities = record.qualities
      .map((q) => {
        const hid = (q.hubcloudId || q.id || "").toString().trim();
        return {
          tag: q.label || `Quality ${q.id}`,
          id: hid,
        };
      })
      .filter((q) => q.id && q.id.length > 0 && isNaN(Number(q.id)));

    if (validQualities.length > 0) {
      try {
        const batchRes = await resolveQualities(validQualities, title);
        if (batchRes && batchRes.qualities) {
          qualitiesList = batchRes.qualities;
        }
      } catch (err) {
        console.warn(`Could not resolve HubCloud qualities for media ${mediaId}:`, err.message);
      }
    }
  }

  // 2. Determine Primary Video URL
  let primaryUrl = "";
  if (qualitiesList.length > 0 && qualitiesList[0].url) {
    primaryUrl = qualitiesList[0].url;
  } else if (record.videoUrl) {
    primaryUrl = record.videoUrl;
  }

  if (!primaryUrl) {
    throw new Error(`No playable stream URL could be resolved for media id "${mediaId}"`);
  }

  // 3. Build Player Launch URL
  const encodedU = toBase64(primaryUrl);
  const encodedM = toBase64(mimeType);
  const encodedT = toBase64(title);

  let playerUrl = `/player.html?u=${encodeURIComponent(encodedU)}&m=${encodeURIComponent(encodedM)}&t=${encodeURIComponent(encodedT)}`;

  // Bind qualities (q1..qn)
  if (qualitiesList.length > 0) {
    qualitiesList.forEach((q, idx) => {
      const qNum = idx + 1;
      playerUrl += `&q${qNum}=${encodeURIComponent(toBase64(q.url))}`;
      playerUrl += `&q${qNum}_label=${encodeURIComponent(toBase64(q.tag))}`;
    });
  }

  // Bind audio tracks (au1..aun)
  if (Array.isArray(record.audioTracks)) {
    record.audioTracks.forEach((au, idx) => {
      if (au.url && au.url.trim()) {
        const auNum = idx + 1;
        playerUrl += `&au${auNum}=${encodeURIComponent(toBase64(au.url.trim()))}`;
        if (au.label) playerUrl += `&au${auNum}_label=${encodeURIComponent(toBase64(au.label))}`;
        if (au.lang) playerUrl += `&au${auNum}_lang=${encodeURIComponent(au.lang)}`;
      }
    });
  }

  // Bind subtitle tracks (su1..sun)
  if (Array.isArray(record.subtitleTracks)) {
    record.subtitleTracks.forEach((su, idx) => {
      if (su.url && su.url.trim()) {
        const suNum = idx + 1;
        playerUrl += `&su${suNum}=${encodeURIComponent(toBase64(su.url.trim()))}`;
        if (su.label) playerUrl += `&su${suNum}_label=${encodeURIComponent(toBase64(su.label))}`;
        if (su.lang) playerUrl += `&su${suNum}_lang=${encodeURIComponent(su.lang)}`;
      }
    });
  }

  return {
    success: true,
    id: record.id || mediaId,
    title,
    mimeType,
    primaryUrl,
    qualities: qualitiesList,
    audioTracks: record.audioTracks || [],
    subtitleTracks: record.subtitleTracks || [],
    playerUrl,
  };
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Render loading HTML page for browser requests
 * Shows animated spinner & auto-redirects to hdhubplayer.html with all query params
 */
function renderLoadingHtml(mediaId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Kineflex</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎬</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;800&display=swap" rel="stylesheet">
<style>
:root{color-scheme:dark;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:#000;color:#fff;font-family:'Sora',system-ui,-apple-system,'Segoe UI',sans-serif;overflow:hidden}
.loader{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px;padding:20px;text-align:center;
  background:radial-gradient(90% 70% at 50% 35%,#262626 0%,#000 72%);transition:opacity .6s ease}
.loader.done{opacity:0;pointer-events:none}
.lockup{display:flex;align-items:center;gap:22px;flex-wrap:wrap;justify-content:center}

/* logo with spinning ring */
.ring{position:relative;width:132px;height:132px;display:grid;place-items:center;animation:markIn 1s cubic-bezier(.2,.9,.3,1.2) both}
.ring::before{content:"";position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,rgba(255,255,255,0),#fff);
  -webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 4px),#000 calc(100% - 3px));mask:radial-gradient(farthest-side,transparent calc(100% - 4px),#000 calc(100% - 3px));
  animation:spin 1.4s linear infinite}
.logo{width:110px;height:110px;border-radius:50%;display:block;object-fit:cover;animation:glow 2.4s ease-in-out infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes markIn{0%{transform:scale(0) rotate(-270deg);opacity:0}100%{transform:none;opacity:1}}
@keyframes glow{0%,100%{box-shadow:0 0 14px 0 rgba(255,255,255,.35)}50%{box-shadow:0 0 42px 8px rgba(255,255,255,.55)}}

/* text */
.word{display:flex;font-weight:800;font-size:clamp(46px,11vw,84px);letter-spacing:-.02em;line-height:1}
.word span{display:inline-block;opacity:0;background:linear-gradient(100deg,#9a9a9a,#fff 45%,#cfcfcf);-webkit-background-clip:text;background-clip:text;color:transparent;
  animation:letterIn .7s cubic-bezier(.2,.9,.3,1) both;animation-delay:calc(.5s + var(--i)*.08s)}
@keyframes letterIn{0%{opacity:0;transform:translateY(50px) scale(.7);filter:blur(10px)}100%{opacity:1;transform:none;filter:blur(0)}}
.tag{margin:0;font-weight:300;font-size:13px;letter-spacing:.34em;color:#9a9a9a;opacity:0;animation:fade .8s 1.5s ease both}
@keyframes fade{to{opacity:1}}

/* progress */
.bar{width:min(240px,70vw);height:3px;border-radius:3px;background:#262626;overflow:hidden;opacity:0;animation:fade .6s 1.2s ease both}
.bar i{display:block;height:100%;width:40%;border-radius:3px;background:linear-gradient(90deg,transparent,#fff,transparent);animation:run 1.3s ease-in-out infinite}
@keyframes run{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
.status{margin:-14px 0 0;font-size:12px;letter-spacing:.3em;color:#777;text-transform:uppercase;opacity:0;animation:fade .6s 1.4s ease both}
.status b{font-weight:300;display:inline-block;width:1.2em;text-align:left}

/* media info + error */
.media{display:flex;flex-direction:column;align-items:center;gap:8px;margin:-10px 0 0;max-width:min(480px,90vw)}
.title{margin:0;font-weight:800;font-size:15px;line-height:1.4;color:#e5e5e5;overflow-wrap:anywhere;opacity:0;transition:opacity .4s}
.title.on{opacity:1}
.badge{font:12px ui-monospace,monospace;color:#cfcfcf;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);padding:3px 8px;border-radius:6px}
.badge:empty{display:none}
.err{display:none;max-width:min(420px,90vw);background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);color:#fca5a5;padding:12px 16px;border-radius:8px;font-size:13px;line-height:1.4}
.retry{display:none;font:inherit;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#000;background:#fff;border:0;border-radius:6px;padding:9px 18px;cursor:pointer}
.failed .bar,.failed .status{display:none}
.failed .err,.failed .retry{display:block}
@media (prefers-reduced-motion:reduce){.ring::before{animation-duration:6s}}
</style>
</head>
<body>
<div class="loader" id="loader" role="status" aria-live="polite" aria-label="Loading Kineflex">
  <div class="lockup">
    <div class="ring"><img class="logo" src="https://cdn.imgpile.com/f/jZEV1qe_lg.webp" alt="Kineflex logo"></div>
    <div class="word" id="word" aria-hidden="true"></div>
  </div>
  <p class="tag">WATCH · FLEX · REPEAT</p>
  <div class="bar"><i></i></div>
  <div class="media"><p class="title" id="titleText"></p><span class="badge" id="mediaBadge"></span></div>
  <p class="status"><span id="statusText">Loading</span><b id="dots"></b></p>
  <div class="err" id="errorBox"></div>
  <button class="retry" id="retryBtn" type="button">Retry</button>
</div>

<script>
const BRAND = 'Kineflex';
const word = document.getElementById('word');
[...BRAND].forEach((ch,i)=>{
  const s = document.createElement('span');
  s.textContent = ch; s.style.setProperty('--i',i);
  word.appendChild(s);
});
let n = 0;
setInterval(()=>{ n = (n+1)%4; document.getElementById('dots').textContent = '.'.repeat(n); },400);

// Call hideLoader() from your app when loading is finished.
window.hideLoader = ()=>{
  const l = document.getElementById('loader');
  l.classList.add('done');
  setTimeout(()=>l.remove(),700);
};

// ---- server logic: resolve stream, then redirect to player ----
// SERVER TEMPLATE: replace the next line with  const mediaId = "${escapeHtml(mediaId)}";
// (and escape backticks/${} inside the template literal)
const mediaId = new URLSearchParams(location.search).get('id') || '';
const $ = id => document.getElementById(id);
$('mediaBadge').textContent = mediaId ? '#' + mediaId : '';

async function resolveAndPlay(){
  $('loader').classList.remove('failed');
  $('statusText').textContent = 'Resolving fastest server';
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), 25000);
  try{
    if(!mediaId) throw new Error('Missing media id');
    const res = await fetch(`/api/hubcloud?play=${encodeURIComponent(mediaId)}&format=json`, {signal: ctrl.signal});
    const data = await res.json().catch(()=>({}));
    if(!res.ok || !data.success || !data.playerUrl) throw new Error(data.error || 'No playable stream available');
    if(data.title){ $('titleText').textContent = data.title; $('titleText').classList.add('on'); }
    $('statusText').textContent = 'Launching player';
    window.location.replace(data.playerUrl);
  }catch(err){
    $('errorBox').textContent = 'Failed to load video: ' + (err.name === 'AbortError' ? 'request timed out' : err.message);
    $('loader').classList.add('failed');
  }finally{ clearTimeout(t); }
}
$('retryBtn').addEventListener('click', resolveAndPlay);
resolveAndPlay();
</script>
</body>
</html>`;
}

/**
 * Universal Vercel Request Handler
 * Supports both Node.js serverless and Vercel Edge Runtime
 */
export default async function handler(req, res) {
  const isNode = res && typeof res.end === "function";

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-password",
  };

  function sendResponse(status, headers = {}, body = "") {
    const combinedHeaders = { ...corsHeaders, ...headers };
    if (isNode) {
      if (typeof res.status === "function") {
        res.status(status);
        Object.entries(combinedHeaders).forEach(([k, v]) => res.setHeader(k, v));
        if (typeof body === "object" && !(body instanceof Buffer)) {
          return res.json(body);
        }
        return res.send(body);
      } else {
        let finalBody = body;
        if (typeof body === "object" && !(body instanceof Buffer)) {
          finalBody = JSON.stringify(body, null, 2);
          combinedHeaders["Content-Type"] = "application/json";
        }
        res.writeHead(status, combinedHeaders);
        res.end(finalBody);
        return;
      }
    }

    // Web Standard Response (Edge Runtime / Cloudflare Workers)
    let respBody = body;
    if (typeof body === "object" && !(body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array || typeof body === "string")) {
      respBody = JSON.stringify(body, null, 2);
      combinedHeaders["Content-Type"] = "application/json";
    }
    return new Response(respBody, { status, headers: combinedHeaders });
  }

  const method = (req.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return sendResponse(204);
  }

  // Parse URL & Query params
  let urlObj;
  if (req.url && (req.url.startsWith("http://") || req.url.startsWith("https://"))) {
    urlObj = new URL(req.url);
  } else {
    const host = req.headers?.host || "localhost";
    const proto = req.headers?.["x-forwarded-proto"] || "https";
    urlObj = new URL(req.url || "/", `${proto}://${host}`);
  }

  // Parse request body
  let postBody = null;
  if (req.body && typeof req.body === "object") {
    postBody = req.body;
  } else if (typeof req.json === "function") {
    try {
      postBody = await req.json();
    } catch {}
  } else if (isNode && (method === "POST" || method === "DELETE")) {
    try {
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      const rawText = Buffer.concat(buffers).toString("utf-8");
      if (rawText) postBody = JSON.parse(rawText);
    } catch {}
  }

  // Admin authentication check
  const action = urlObj.searchParams.get("action") || req.query?.action || "";
  const headerPwd = isNode
    ? (req.headers?.["x-admin-password"] || "")
    : (req.headers?.get ? req.headers.get("x-admin-password") || "" : "");
  const providedPassword =
    headerPwd ||
    urlObj.searchParams.get("password") ||
    req.query?.password ||
    postBody?.password ||
    "";

  // --- Admin Endpoints (Protected by 9310081539) ---
  if (action.startsWith("admin-") || ["list", "get", "save", "delete"].includes(action)) {
    if (providedPassword !== ADMIN_PASSWORD) {
      return sendResponse(401, { "Content-Type": "application/json" }, {
        error: "Unauthorized: Invalid admin password"
      });
    }

    if (action === "list" || action === "admin-list") {
      const items = await listMedia();
      return sendResponse(200, { "Content-Type": "application/json" }, {
        success: true,
        items
      });
    }

    if (action === "get" || action === "admin-get") {
      const id = urlObj.searchParams.get("id") || req.query?.id || postBody?.id;
      const item = await getMedia(id);
      if (!item) {
        return sendResponse(404, { "Content-Type": "application/json" }, {
          error: `Item with id "${id}" not found`
        });
      }
      return sendResponse(200, { "Content-Type": "application/json" }, {
        success: true,
        item
      });
    }

    if (action === "save" || action === "admin-save") {
      const payload = postBody?.data || postBody;
      if (!payload || !payload.id) {
        return sendResponse(400, { "Content-Type": "application/json" }, {
          error: "Missing required 'id' in media payload"
        });
      }
      const saveRes = await saveMedia(payload.id, payload);
      return sendResponse(200, { "Content-Type": "application/json" }, {
        success: true,
        id: payload.id,
        storage: saveRes.storage,
        url: saveRes.url || undefined
      });
    }

    if (action === "delete" || action === "admin-delete") {
      const id = urlObj.searchParams.get("id") || req.query?.id || postBody?.id;
      await deleteMedia(id);
      return sendResponse(200, { "Content-Type": "application/json" }, {
        success: true,
        deleted: id
      });
    }
  }

  // --- User Endpoint: Play by Stored Media ID (e.g. ?play=6672 or ?mediaId=6672) ---
  const mediaId = urlObj.searchParams.get("play") || urlObj.searchParams.get("mediaId") || req.query?.play || req.query?.mediaId;
  if (mediaId) {
    const acceptHeader = isNode
      ? (req.headers?.["accept"] || "")
      : (req.headers?.get ? req.headers.get("accept") || "" : "");
    const format = urlObj.searchParams.get("format") || req.query?.format;
    const redirectParam = urlObj.searchParams.get("redirect") || req.query?.redirect;

    const isHtmlRequest = acceptHeader.includes("text/html") && format !== "json";

    if (isHtmlRequest && redirectParam !== "true") {
      return sendResponse(200, { "Content-Type": "text/html; charset=utf-8" }, renderLoadingHtml(mediaId));
    }

    try {
      const resolvedData = await resolveMediaRecord(mediaId);
      if (redirectParam === "true") {
        if (isNode && typeof res.redirect === "function") {
          return res.redirect(302, resolvedData.playerUrl);
        }
        return sendResponse(302, { Location: resolvedData.playerUrl });
      }
      return sendResponse(200, { "Content-Type": "application/json" }, resolvedData);
    } catch (err) {
      return sendResponse(500, { "Content-Type": "application/json" }, { error: err.message });
    }
  }

  // --- Batch Multi-Quality request (POST body or GET ?qualities=...) ---
  let batchQualities = null;
  let customTitle = urlObj.searchParams.get("title") || req.query?.title || postBody?.title || "";

  if (urlObj.searchParams.has("qualities") || req.query?.qualities) {
    try {
      const rawQ = urlObj.searchParams.get("qualities") || req.query?.qualities;
      batchQualities = typeof rawQ === "string" ? JSON.parse(rawQ) : rawQ;
    } catch {}
  } else if (postBody?.qualities && Array.isArray(postBody.qualities)) {
    batchQualities = postBody.qualities;
  }

  if (batchQualities && Array.isArray(batchQualities)) {
    try {
      const batchData = await resolveQualities(batchQualities, customTitle);
      return sendResponse(200, { "Content-Type": "application/json" }, batchData);
    } catch (err) {
      return sendResponse(500, { "Content-Type": "application/json" }, {
        error: err.message || "Batch resolution failed"
      });
    }
  }

  // --- Single link extraction ---
  let targetUrl =
    urlObj.searchParams.get("url") ||
    urlObj.searchParams.get("id") ||
    req.query?.url ||
    req.query?.id ||
    postBody?.url ||
    postBody?.id;

  if (!targetUrl) {
    return sendResponse(400, { "Content-Type": "application/json" }, {
      error: "Missing required parameter 'url', 'id', 'qualities', or 'play'",
      playExample: "/api/hubcloud?play=6672",
      singleExample: "/api/hubcloud?url=https://hubcloud.mov/drive/ciudcwrxjfchbsh",
      batchExample: {
        qualities: [
          { tag: "4K HDR", id: "6rd1fa6fy66761f" },
          { tag: "1080p", id: "ciudcwrxjfchbsh" },
        ],
      },
    });
  }

  try {
    const data = await extractHubCloud(targetUrl);
    return sendResponse(200, { "Content-Type": "application/json" }, data);
  } catch (err) {
    return sendResponse(500, { "Content-Type": "application/json" }, {
      error: err.message || "Extraction failed"
    });
  }
}

// Export named extractor and batch resolver for local/script usage
export { extractHubCloud, resolveQualities, selectBestStream };
