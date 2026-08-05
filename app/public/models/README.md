# Avatar Models

This directory contains VRM avatar models for Code Siren's Face View.

## Structure

```
models/
  manifest.json              ← List of all available avatars (for the picker UI)
  avatars/
    default/
      model.vrm              ← Default VRM 1.0 avatar (18 expressions, spring bones)
    hatsune-miku/
      model.vrm              ← VRM 0.x Hatsune Miku (14 blendShapes)
    secondary/
      model.vrm              ← VRM 0.x secondary avatar (no expressions)
  sample.vrm                 ← Legacy path (kept for backwards compat — same as default/model.vrm)
  lip-sync-profile.json      ← wlipsync MFCC vowel profile
```

## Adding More Avatars

The remaining 16 VRM models are distributed via Google Drive (not committed to
the repo to keep the git size manageable — 3 models at ~49 MB is the practical
limit for direct git storage).

To add a downloaded VRM:

1. Create a folder: `app/public/models/avatars/<name>/`
2. Copy the .vrm file into it as `model.vrm`
3. Add an entry to `manifest.json` with the avatar's metadata
4. The avatar picker UI will automatically pick it up

## VRM Format Support

Code Siren uses `@pixiv/three-vrm` v3.5.5, which supports both:
- **VRM 0.x** — blendShapeMaster with preset names (a, i, u, e, o, blink, joy, angry, sorrow, fun)
- **VRM 1.0** — VRMC_vrm expressions with preset names (aa, ih, ou, ee, oh, blink, happy, angry, sad, relaxed, surprised, neutral)

The `VRMLoaderPlugin` auto-detects the format and maps VRM 0.x blendShape
presets to VRM 1.0 expression presets — no code changes needed per model.

## Model Quality Notes

- Models with 0 expressions (like `secondary`) will render but won't support
  blink/lip-sync/emotion — the avatar will have a static face
- Models with spring bones (hair/cloth physics) work automatically —
  `vrm.update(delta)` in the render loop handles them
- VRM 0.x materials are auto-converted to VRM 1.0-compatible format by
  `VRMMaterialsV0CompatPlugin`
