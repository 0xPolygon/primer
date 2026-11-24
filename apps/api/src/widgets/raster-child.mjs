// Draws one widget SVG for raster.ts, in a process of its own so the API can
// kill a render that runs too long. Reads {svg, options} as JSON on stdin and
// writes the PNG to stdout. Plain JavaScript, so dev and the production image
// run the same file (build.mjs copies it to dist/widgets/).
import { Resvg } from '@resvg/resvg-js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { svg, options } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
process.stdout.write(new Resvg(svg, options).render().asPng());
