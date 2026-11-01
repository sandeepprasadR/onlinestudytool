# Study Board

A simple writing board for teaching online from an iPad with Apple Pencil, in the style of Notability.
Open it in Safari, share the iPad screen in Google Meet, and write.

## What it does

- Write with Apple Pencil (pressure-sensitive pen). Fingers only scroll and zoom, so a resting palm does not draw.
- Import any PDF (textbook chapter, worksheet, sample paper) and write on its pages.
- Add blank pages between PDF pages: blank, ruled, graph (squares), dotted or blackboard.
- Pen, highlighter, stroke eraser, laser pointer (red trail that fades), straight line, arrow, rectangle and circle.
  Lines snap to horizontal, vertical and 45 degrees; near-circles snap to true circles.
- Undo and redo, several notebooks, automatic saving on the iPad.
- Export the whole notebook, with your writing, as a PDF through the iPad share sheet (Files, WhatsApp, Mail).

## Use it on the iPad

1. Open the site in Safari (see Hosting below).
2. Tap Share, then **Add to Home Screen**. It then opens full screen like an app.
3. In Google Meet on the iPad, tap the three dots, then **Share screen**, then **Start Broadcast**.
   Switch to Study Board and teach. Turn on a Focus mode so notifications do not show on the shared screen.

Notebooks are stored in the browser on that iPad. Clearing Safari website data removes them, so export
important notes as PDF.

## Hosting (GitHub Pages)

Repository **Settings > Pages > Build and deployment**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
The site then appears at `https://<github-username>.github.io/onlinestudytool/`.

## Files

- `index.html`: the whole app (HTML, CSS and JavaScript, no build step).
- `vendor/`: pdf.js 3.11.174 (reads PDFs) and jsPDF 2.5.1 (writes the export), with their licences.
- `manifest.webmanifest`, `icon-*.png`: Home Screen app icon and name.
