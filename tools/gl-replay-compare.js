'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const [, , first, second, output] = process.argv;
const browserPath = process.env.CHROME;
if (!browserPath || !first || !second) {
  console.error('Usage: CHROME=<path> node tools/gl-replay-compare.js <a.png> <b.png> [diff.png]');
  process.exit(1);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage();
  const dataUrl = file => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  const result = await page.evaluate(async (a, b) => {
    const load = url => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.min(ia.width, ib.width);
    const h = Math.min(ia.height, ib.height);
    const read = image => {
      const canvas = new OffscreenCanvas(w, h);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, w, h);
    };
    const pa = read(ia).data;
    const pb = read(ib).data;
    const out = new ImageData(w, h);
    let sum = 0, over8 = 0, over32 = 0, max = 0;
    for (let i = 0; i < pa.length; i += 4) {
      const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
      sum += d;
      if (d > 8) over8++;
      if (d > 32) over32++;
      if (d > max) max = d;
      const v = Math.min(255, d * 4);
      out.data[i] = v;
      out.data[i + 1] = v;
      out.data[i + 2] = v;
      out.data[i + 3] = 255;
    }
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').putImageData(out, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    const total = w * h;
    return { width: w, height: h, sizes: [[ia.width, ia.height], [ib.width, ib.height]], meanDiff: +(sum / total).toFixed(3), percentOver8: +(over8 / total * 100).toFixed(3), percentOver32: +(over32 / total * 100).toFixed(3), max, diff: btoa(text) };
  }, dataUrl(first), dataUrl(second));
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, Buffer.from(result.diff, 'base64'));
  }
  delete result.diff;
  console.log(JSON.stringify(result));
  await browser.close();
})().catch(error => {
  console.error(String(error.stack || error).slice(0, 600));
  process.exit(1);
});
