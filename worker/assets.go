// Package worker exposes the viewer SPA (index.html, app.js, style.css) as an
// embedded filesystem. The files live here — inside the Cloudflare Worker
// project that serves them in production — and cmd/barreplay-viz embeds the
// SAME files for local serving, so the repo has exactly one copy of the
// front-end. Everything else in this directory (TypeScript worker, Vite
// config, node_modules) is invisible to Go.
package worker

import "embed"

//go:embed index.html public/app.js public/style.css
var Assets embed.FS
