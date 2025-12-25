import { corsHeaders, mimeTypes } from './utils'

export async function handleDeleteFile(request, env, ctx) {
    const url = new URL(request.url);

    const filePath = decodeURIComponent(url.pathname.slice(1)); // Remove leading slash
    if (filePath.includes("..")) {
        return new Response("Invalid path", { status: 400 });
    }
    try {
        await env.MY_BUCKET.delete(filePath);

        let dir = "/";
        if (filePath.includes("/")) {
            const idx = filePath.lastIndexOf("/");
            dir = idx > 0 ? "/" + filePath.substring(0, idx) : "/";
        }

        const listingUrl = new URL(dir, url.origin).toString();
        const cache = caches.default;
        const cacheKey = new Request(listingUrl, { cf: { cacheTtl: 604800 } });
        ctx.waitUntil(cache.delete(cacheKey));

        return new Response('File deleted successfully', { status: 200, headers: corsHeaders });
    } catch (error) {
        return new Response('Failed to delete file: ' + error.message, { status: 500, headers: corsHeaders });
    }
}

export async function handleMultpleUploads(request, env, ctx) {
    const formData = await request.formData();
    const results = [];
    for (const entry of formData.entries()) {
        const [fieldName, file] = entry;
        if (file instanceof File) {
            const filename = file.name;
            const extension = filename.split(".").pop().toLowerCase();
            const contentType = mimeTypes[extension] || mimeTypes.default;
            const data = await file.arrayBuffer();
            const sanitizedFilename = filename.replace(/^\/+/, ""); //remove leading slashes
            if (filename.includes("..")) { // Block path traversal
                return new Response("Invalid path", { status: 400 });
            }
            if (!sanitizedFilename) return new Response("Invalid filename", { status: 400 });
            try {
                await env.MY_BUCKET.put(sanitizedFilename, data, { httpMetadata: { contentType } });
                results.push({ sanitizedFilename, status: "success", contentType });

                const cache = caches.default;
                const cacheKey = new Request(new URL("/", request.url).toString(), { cf: { cacheTtl: 604800 } });
                ctx.waitUntil(cache.delete(cacheKey));

            } catch (error) {
                results.push({ filename, status: "failed", error: error.message });
            }
        }
    }

    return new Response(JSON.stringify(results), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

export async function handleGetFile(request, env) {
    let path = new URL(request.url).pathname;
    const filename = decodeURIComponent(path.slice(1));
    
    if(path === '/'){
        return new Response("Use /dav for WebDAV", { status: 302, headers: { Location: "/dav", ...corsHeaders } });
    }

    const file = await env.MY_BUCKET.get(filename);

    if (file === null) {
        return new Response("File not found", { status: 404, headers: corsHeaders });
    }

    const extension = filename.split(".").pop().toLowerCase();
    const contentType = mimeTypes[extension] || mimeTypes.default;

    return new Response(file.body, {
        headers: {
            ...corsHeaders,
            "Content-Type": contentType,
            "Content-Disposition": `inline; filename="${filename}"`,
        },
    });
}

export async function handlePutFile(request, env, ctx) {
    const url = new URL(request.url);
    let filePath = decodeURIComponent(url.pathname);

    if (filePath.includes("..") || filePath.trim() === "") {
        return new Response("Invalid path", { status: 400, headers: corsHeaders });
    }

    filePath = filePath.replace(/^\/+/, ""); // Remove all leading slashes

    try {
        const data = await request.arrayBuffer();
        const extension = filePath.split(".").pop().toLowerCase();
        const contentType = mimeTypes[extension] || "application/octet-stream";

        await env.MY_BUCKET.put(filePath, data, { httpMetadata: { contentType } });

        const cache = caches.default;
        const listingUrl = new URL("/", request.url).toString();
        const cacheKey = new Request(listingUrl);
        ctx.waitUntil(cache.delete(cacheKey));

        return new Response("File uploaded successfully", { status: 201, headers: corsHeaders });
    } catch (error) {
        return new Response("Failed to upload file: " + error.message, { status: 500, headers: corsHeaders });
    }
}

export async function handleFileList(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;
    
    // Normalize path
    if (!path.startsWith("/")) path = "/" + path;
    if (path.endsWith("/") && path !== "/") path = path.slice(0, -1);

    try {
        // List objects in R2
        let prefix = path === "/" ? "" : path.slice(1);
        if (prefix && !prefix.endsWith("/")) prefix += "/";

        const listResult = await env.MY_BUCKET.list({ prefix });
        const objects = listResult.objects || [];

        // Build WebDAV XML response
        let xmlResponse = `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${encodeURI(path)}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:displayname>${path === "/" ? "root" : path.split("/").pop()}</D:displayname>
        <D:creationdate>2024-01-01T00:00:00Z</D:creationdate>
        <D:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;

        // Add each file/folder
        for (const obj of objects) {
            const objPath = "/" + obj.key;
            const isFolder = obj.key.endsWith("/");
            
            xmlResponse += `
  <D:response>
    <D:href>${encodeURI(objPath)}</D:href>
    <D:propstat>
      <D:prop>
        ${isFolder ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>'}
        <D:displayname>${obj.key.split("/").filter(x => x).pop() || obj.key}</D:displayname>
        <D:getcontentlength>${obj.size}</D:getcontentlength>
        <D:getlastmodified>${new Date(obj.uploaded).toUTCString()}</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
        }

        xmlResponse += `
</D:multistatus>`;

        return new Response(xmlResponse, {
            status: 207,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/xml; charset=utf-8",
                "DAV": "1, 2",
            },
        });
    } catch (error) {
        return new Response(`<?xml version="1.0" encoding="utf-8" ?><D:error xmlns:D="DAV:">${error.message}</D:error>`, {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/xml" },
        });
    }
}

export async function dumpCache(request, env, ctx){
    const url = new URL(request.url);
    try {
        const listingUrl = new URL('/', url.origin).toString();
        const cache = caches.default;
        const cacheKey = new Request(listingUrl, { cf: { cacheTtl: 604800 } });
        ctx.waitUntil(cache.delete(cacheKey));
        return new Response('cache deleted successfully', { status: 200, headers: corsHeaders });
    } catch (error) {
        return new Response('Failed to delete cache: ' + error.message, { status: 500, headers: corsHeaders });
    }
}
