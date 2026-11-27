# Image → PES embroidery converter

A browser app that turns a PNG, JPEG or SVG into a Brother **.pes** embroidery file. Everything runs on your machine in the browser. There's no server, no build step and no dependencies.

## Run it

Open `index.html` in Chrome, Edge, Firefox or Safari. Double-clicking the file works. You can also serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

Then drop, paste or browse for an image, set the size in mm and click **Download .pes**.

Click any shape in the preview to skip it or bring it back. Clicking an enclosed gap (for example between two arms) makes it stitched.

The app works best with logos, clip-art, lettering and flat-colour drawings. SVGs give the cleanest edges, because the vector is rasterised at exactly the resolution the digitizer needs. Photos get posterised into a few thread colours.

## What it does

1. **Colour reduction.** It runs k-means in CIE Lab colour space and matches threads with CIEDE2000, the perceptual colour difference used for thread matching, so a dull brown maps to a brown thread rather than grey. The background colour is detected from the image border (transparent PNGs are handled). Colours are snapped to the 64-colour Brother thread chart, because PES v1 stores colours as indices into that chart, so the preview matches what the machine shows.
2. **Blend-colour merging.** Anti-aliasing and JPEG blur leave thin bands of in-between colour along every edge, such as dark red between red and a black outline. K-means would turn those into extra threads and hundreds of slivers. A colour is dissolved when it is spatially thin (most of its pixels within 2 px of another colour) and is either between two neighbouring colours in Lab space or a close shade of one. Each of its pixels then joins the nearest real colour, which also sharpens the edge. The colour slider is therefore a *maximum*: the app keeps only the colours actually in the artwork.
3. **Fewer thread changes (sequence steps).** Every colour is a machine stop where the operator changes thread, so colours are kept to a minimum:
   - **Merge near-identical threads.** Colours whose threads are perceptually near-identical (CIEDE2000 below the "Merge colours closer than" setting, 10 by default) are merged.
   - **Fold tiny colours.** A colour covering only a few mm² that resembles the colour it touches is folded into it. Small but distinct colours, like an orange beak, are kept.
   - **Exact budget.** "Maximum colours" is an exact budget. When it's exceeded, the colour that costs least to lose (area × perceptual difference) is dropped, and each of its pixels joins the remaining colour it resembles most.
   - **One block per thread.** Colours that end up with the same thread, including your own thread choices, are sewn as a single block, so a thread is never revisited.
   - **Stop count.** The stats bar shows the number of colours and stops.
4. **Edge smoothing.** Each colour's mask is Gaussian-blurred and each pixel takes the strongest colour. This turns JPEG and pixel raggedness into smooth curves at a scale set in mm. Thin features such as outlines are protected: smoothing never erodes them or opens gaps in them. Their edges are smoothed later by the satin stage instead.
5. **Background.** By default only the background connected to the image border is removed. A background-coloured area enclosed by the design is stitched only if it is compact *and* has artwork inside it, like an eye white with a pupil. Empty holes stay as fabric: letter counters (e, o, B), gaps between legs, or between an arm and the body. Clicking a shape overrides this either way. You can also choose to remove every background-coloured pixel, or stitch the background too.
6. **Cleanup.** Specks smaller than the minimum detail size get merged into their neighbours.
7. **Shapes.** Each connected area of a colour becomes a shape, with a sub-pixel smooth outline (a blurred distance field). Each shape is sewn as **satin** if it is narrow enough (under 5.5 mm by default) and as **tatami fill** otherwise.
8. **Machine commands.** The shapes are converted into stitches, jumps, trims, lock stitches and colour changes, then written as PES v1 with an embedded PEC section, including the thumbnails the machine shows.

## Stitch engineering

### Tatami fill (`js/fill.js`)

- **Scan rows.** Rows run at the fill angle and the chosen density (0.42 mm default). The row ends are found to sub-pixel precision.
- **Sections.** Rows are split into sections where each row overlaps exactly one row in the next. A section can be sewn back and forth without leaving the shape. Each row-to-row link is checked to stay inside the outline.
- **Staggered needle grid.** Needle points sit on one grid shared across the whole design, offset row by row (classic ¼, ½, ⅓, smooth or random patterns). This gives an even tatami texture instead of visible channels.
- **Smooth row ends.** Row ends are smoothed along each section edge. Large jumps between neighbouring rows are left alone, so real corners stay sharp.
- **Pull compensation.** Row ends are extended so the fabric pulling in doesn't open gaps at the edges.
- **Colour overlap.** Shapes grow slightly *into neighbouring colours only*, never out into the background, so no fabric shows between colours.
- **Underlay.** An edge walk inset from the outline, plus a sparse cross-hatch at 90° to the top stitching. This stabilises the fabric and lifts the top stitches.
- **Angle choice.** The fill angle is optimised per shape to keep the number of sections (and therefore travel) low, with a bias towards the angle you set.
- **Travel routing.** Travel between sections uses A* inside the shape. It prefers cells that haven't been top-stitched yet, so travel stitches end up buried under later rows instead of sitting on top.

### Satin (`js/satin.js`)

- **Centre lines.** Shapes are thinned to a skeleton graph. Corner spurs are removed by a reconstruction test (does this branch add shape beyond the junction's own circle?). Real short arms, such as the crossbar of a "t", are kept.
- **Corners.** Sharp corners split the column into two overlapping columns, the way a hand digitizer mitres the apex of an "A". Without this, the stitches fan out round the corner.
- **Stitch direction.** At each step along the centre line, rays are cast both ways along the local normal to find the outline. Stitches therefore always cross the stroke and rotate smoothly round curves. Stroke tips are extended so they taper naturally.
- **Even edges.** Edge distances are smoothed along the column (spike filter, then a weighted average that is never allowed to widen past the true edge), so wobble in the source outline doesn't show in the satin.
- **Junctions like a hand digitizer.** At each junction, the two branches that continue most nearly straight are sewn as one continuous column through it (the trunk). The other branches butt into the trunk's edge instead of piling into the centre. That gives clean H, T and E joins and avoids thick knots of thread.
- **Square stroke ends.** Columns finish with a full-width stitch row just inside the end of the stroke.
- **Width-proportional pull compensation.** Satin widens each side by 0.08 + 0.04 × width (capped at 0.25 mm). Fabric pulls wide columns in more than thin lettering.
- **Width near junctions.** Near junctions the width is held to the column's own typical width, so the rays don't run into the other branch. A spike filter removes outliers.
- **Tight curves.** Alternating short stitches on the inside of tight curves stop the needle hammering one spot.
- **One continuous pass.** The graph is sewn as a depth-first walk. Going *out* along a branch lays the underlay (centre walk or zig-zag); coming *back* lays the satin on top. Each satin shape is sewn in one pass with no jumps, and every underlay stitch is covered.
- **Rings around features.** An eye white around a pupil, or a rim around a button, can only be satined radially. If the ring is thick compared with the hole (rays cast outward from the hole's edge measure this), it is sewn as fill instead. Thin outlines drawn around things and letter counters stay satin.
- **No starbursts.** Satin is rejected for wide columns that bend tightly, such as a fat ring of white round a pupil or a thick crescent. There the stitches would converge on the inside and splay on the outside. It measures curvature × half-width along each column, and if more than 60% of the column fans badly (outer spacing over ~2.6× inner), the shape is sewn as tatami fill instead. Lettering and thin rings stay satin.
- **Fallbacks.** If the skeleton doesn't cover the shape well, a straight-across scan satin is tried, then tatami fill.

### Machine level (`js/digitize.js`, `js/pes.js`)

- **Lock stitches.** Tie-in and tie-off stitches are added at every start, trim and colour change.
- **Trims.** Jumps longer than the trim threshold (1 mm by default) get a trim. Shorter gaps become connecting stitches.
- **Stitch length limits.** Stitches never go below 0.3 mm. Long moves are split to fit the format's 12-bit range.
- **Sew order and overlap.** Colours are sewn thickest first and thinnest last. Broad fills go down first, and thin strokes (outlines, lettering) are sewn last so they sit crisply on top of whatever they border: a black eye outline always covers the edge of the eye white, never the reverse. Overlap is one-way: each shape tucks 0.25 mm *under* colours sewn after it, and later colours keep their true edges, so outlines aren't eaten.
- **Fewer trims and sequence items.** Each trim starts a new stitch run, and software like Hatch lists each run as a sequence item, so trims are avoided wherever the connection can't be seen:
  - **Biggest piece last.** The largest piece of each colour (for a cartoon, the outline network) is sewn last. Connectors between the smaller pieces are routed (A*) underneath it, or under colours sewn later, and get buried.
  - **Short connectors on stitching.** A short connector (≤ 4 mm) that lies entirely on stitching is used instead of a trim.
  - **Trim as a last resort.** A trim is only made when a connector would cross bare fabric or be long.
  - **Stats.** The stats bar shows trims and runs.
- **No wasted penetrations.** Hidden underlay and travel never make hops under 0.45 mm. Within a colour, shapes are visited nearest-first. You can reorder colours in the sidebar.

## Preview

- **Stitched:** shaded thread rendering on a fabric colour you choose.
- **Stitch paths:** top stitches, underlay, travel, jumps and trims; needle points show when you zoom in.
- **Colour map** and **Original.**
- **Playback:** the slider and ▶ button simulate the stitch-out.

To move around, scroll to zoom, drag to pan and double-click to fit.

## Project layout

```
index.html            UI shell
css/style.css
js/palette.js         Brother thread chart, Lab colour conversion
js/imageproc.js       quantisation, cleanup, components, distance transform, contours, skeleton
js/region.js          per-shape fields + A* travel planner
js/fill.js            tatami fill + underlay
js/satin.js           satin columns
js/digitize.js        pipeline orchestration + command assembly (ties, trims, colour changes)
js/pes.js             PES v1 / PEC writer
js/preview.js         canvas renderer
js/app.js             UI controller
tools/test-node.js    headless pipeline run (synthetic scene or raw RGBA input)
tools/validate_pes.py independent check of a .pes with pyembroidery (+ optional render)
tools/eval.js         stitch-quality evaluation harness (fidelity + machine metrics)
```

## Measuring stitch quality

`tools/eval.js` scores the whole pipeline on a suite of images:

```sh
node tools/eval.js path/to/suite '{"spacing":0.4}'   # optional settings override
```

The suite folder holds `manifest.json` (`[{"name","w","h","mm"}]`) and `<name>.rgba` raw images, already cropped and resized to working resolution (about 0.15 mm per pixel). The harness rasterises the generated stitches with a realistic thread width and fabric pull, then reports two groups of metrics:

- **Fidelity:**
  - accuracy against the intended colour map, overall and at colour edges
  - worst per-colour recall
  - spill onto fabric
  - gaps where fabric shows through
  - wrong-colour coverage
  - mean CIEDE2000 error against the source
- **Machine-friendliness:**
  - stitch and trim counts
  - stitches under 0.4 mm or over 7 mm
  - needle-penetration hotspots
  - thread stacking

Use it to check that a change helps before keeping it.

## Verifying output

```sh
node tools/test-node.js /tmp/test.pes            # digitize a synthetic test scene
pip install pyembroidery pillow
python3 tools/validate_pes.py /tmp/test.pes /tmp/test.png 8
```

During development, files from the app were checked against `pyembroidery`: re-encoding the same stitches with its PES v1 writer produces byte-identical output, including the `CEmbOne`/`CSewSeg` blocks, the PEC stitch stream and the thumbnails.

## Image rights

Users are responsible for having the rights to any image they convert. Characters, logos and artwork you didn't create are usually protected by copyright or trademark. Check you have permission before stitching or selling designs made from them. The app shows this notice under the image upload area.

## Limitations

- **Thread colours.** PES v1 stores colours as Brother chart indices. If you turn off "Snap to Brother thread chart", the file still records the nearest chart thread.
- **Photos.** They are reduced to flat colour areas. There's no photo-stitch or gradient-density mode.
- **Very small lettering.** Text under about 4 mm tall is legible, but less clean than hand digitizing.
- **Test-sew first.** Try a scrap of the same fabric and stabiliser before sewing the real piece; density, pull compensation and underlay may need tuning for stretchy or heavy fabrics.
