import express from 'express';
import https from 'node:https';
import http from 'node:http';

const app = express();
const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
    res.send('Proxy is online and active.');
});

// Headers the CDN expects to see (mirrors real Edge browser UA from network capture)
const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0',
    'sec-ch-ua': '"Microsoft Edge";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Referer': 'https://movie-box.co/',
    'Origin': 'https://movie-box.co',
};

// Headers we forward from the client to the origin (important for range requests)
const CLIENT_FORWARD_HEADERS = ['range', 'if-range', 'if-modified-since', 'if-none-match'];

// Headers we forward from origin back to the client
const ORIGIN_FORWARD_HEADERS = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'last-modified',
    'etag',
    'cache-control',
    'content-disposition',
];

app.get('/proxy', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send('Error: Missing "url" parameter.');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch {
        return res.status(400).send('Error: Invalid URL.');
    }

    console.log(`[Proxy] ${req.method} ${targetUrl}`);

    // Build request headers: base spoofed headers + passthrough client headers
    const outHeaders = { ...BASE_HEADERS };
    for (const h of CLIENT_FORWARD_HEADERS) {
        if (req.headers[h]) {
            outHeaders[h] = req.headers[h];
        }
    }

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: outHeaders,
    };

    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const proxyReq = transport.request(options, (proxyRes) => {
        console.log(`[Proxy] Origin responded ${proxyRes.statusCode} for ${parsedUrl.hostname}`);

        // Forward status (200 or 206 for range)
        res.status(proxyRes.statusCode);

        // Forward safe origin headers
        for (const h of ORIGIN_FORWARD_HEADERS) {
            if (proxyRes.headers[h]) {
                res.setHeader(h, proxyRes.headers[h]);
            }
        }

        // Allow the browser's video player to seek
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');

        proxyRes.pipe(res);

        proxyRes.on('error', (err) => {
            console.error(`[Proxy] Origin stream error: ${err.message}`);
            res.destroy();
        });
    });

    proxyReq.on('error', (err) => {
        console.error(`[Proxy Error] ${err.message}`);
        if (!res.headersSent) {
            res.status(502).send(`Proxy failed: ${err.message}`);
        } else {
            res.destroy();
        }
    });

    // Abort origin request if client disconnects early (saves bandwidth)
    res.on('close', () => {
        if (!res.writableEnded) {
            proxyReq.destroy();
        }
    });

    proxyReq.end();
});

// Also handle HEAD requests (the player sends HEAD first to get content-length)
app.head('/proxy', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).end();
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch {
        return res.status(400).end();
    }

    console.log(`[Proxy] HEAD ${targetUrl}`);

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'HEAD',
        headers: { ...BASE_HEADERS },
    };

    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const proxyReq = transport.request(options, (proxyRes) => {
        res.status(proxyRes.statusCode);
        for (const h of ORIGIN_FORWARD_HEADERS) {
            if (proxyRes.headers[h]) {
                res.setHeader(h, proxyRes.headers[h]);
            }
        }
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end();
    });

    proxyReq.on('error', (err) => {
        console.error(`[Proxy HEAD Error] ${err.message}`);
        res.status(502).end();
    });

    proxyReq.end();
});

app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
