# Content search uses Google SigLIP (base, patch16-224) at half precision

Search by content (spec 0002) embeds every photo and every query with **SigLIP base** (`google/siglip-base-patch16-224`, Apache-2.0; ONNX from `Xenova/siglip-base-patch16-224`), stored as **fp16** weights (vision 186 MB + text 221 MB). We chose it after measuring six model families on a public benchmark, on the owner's Mac, and in a blind test on the owner's own photos. It matched the best model on the owner's photos at about half the download and memory, and it allows commercial distribution.

## How we decided (2026-11-06)

Harness: `scripts/model-eval/` (Transformers.js as the reference implementation, offline). Reproduce with `npm run download && node run-all.mjs` there.

**1. COCO val2017, 1,000 images / ~5,000 captions, text→image recall, owner's Mac (CPU).**

| Model                                    | Precision | R@1      | R@5      | R@10     | ms/photo | query ms | peak MB  |
| ---------------------------------------- | --------- | -------- | -------- | -------- | -------- | -------- | -------- |
| CLIP ViT-B/32 (MIT)                      | fp32      | 49.4     | 77.8     | 87.1     | 17       | 3        | 1590     |
|                                          | fp16      | 49.4     | 77.8     | 87.1     | 17       | 3        | 1475     |
|                                          | int8      | 40.4     | 69.4     | 81.6     | 9        | 1        | 740      |
| CLIP ViT-B/16 (MIT)                      | fp32      | 51.8     | 79.0     | 88.1     | 54       | 3        | 1668     |
|                                          | fp16      | 51.8     | 79.0     | 88.1     | 52       | 3        | 1605     |
|                                          | int8      | 42.3     | 72.2     | 83.7     | 22       | 1        | 817      |
| CLIP ViT-L/14 (MIT)                      | fp16      | 53.8     | 80.6     | 89.0     | 213      | 5        | 3188     |
|                                          | int8      | 49.1     | 76.7     | 86.6     | 81       | 2        | 1505     |
| Nomic Embed Vision 1.5 (Apache-2.0)      | fp32      | 50.3     | 79.4     | 88.9     | 67       | 7        | 2880     |
|                                          | fp16      | 50.3     | 79.4     | 89.0     | 66       | 7        | 2511     |
|                                          | int8      | 42.0     | 71.7     | 83.2     | 36       | 3        | 1650     |
| **SigLIP base (Apache-2.0)**             | fp32      | 63.3     | 87.5     | 93.2     | 54       | 18       | 2492     |
|                                          | **fp16**  | **63.3** | **87.5** | **93.2** | **54**   | **19**   | **2123** |
|                                          | int8      | 60.8     | 85.6     | 92.2     | 25       | 8        | 1335     |
| SigLIP 2 base (Apache-2.0, multilingual) | fp32*     | 68.7     | 89.4     | 94.5     | 54       | 20       | 3389     |
|                                          | fp16      | 68.7     | 89.4     | 94.5     | 54       | 20       | 3641     |
|                                          | int8      | 34.0     | 59.2     | 70.7     | 25       | 8        | 2070     |

\* SigLIP 2's fp32 run uses the fp16 text model (fp32 text is 1.1 GB).

**2. Compression on the owner's library (904 photos, 53 queries): share of each top 20 unchanged versus full precision.** fp16: 99–100% (lossless). int8: SigLIP 69%, CLIP-L 55%; SigLIP 2's int8 collapses on COCO.

**3. Blind test on the owner's photos.** 13 searches (5 from the spec, 8 chosen by the owner), each model's top 20 shown under random letters; the owner ticked relevant photos. SigLIP 2 fp16 192/260, SigLIP fp16 189/260, CLIP-L fp16 174/260. Each scored ≥ 15/20 on 7 of the 13 searches; some searches (a named castle, "family photos from the last year", snowboarding) need features beyond content search or have fewer than 15 matching photos in the library, so that count understates quality. The owner judged the result clear enough without a per-search breakdown.

## Considered and rejected

- **SigLIP 2 base**: best benchmark score and multilingual queries, but tied on the owner's photos at nearly twice the download (751 MB) and ~1.5 GB more memory. The likely upgrade when multilingual search matters for a release; the analysis is versioned (spec 0002, AC-10), so switching re-analyses in the background.
- **CLIP family**: 10–15 points behind SigLIP; ViT-L/14 also 4x slower.
- **Nomic Embed Vision 1.5**: CLIP-level quality at higher cost.
- **Any int8 model**: loses 2–9 points on the benchmark and changes a third or more of results on the owner's photos.
- **Apple MobileCLIP / DFN** (research-only licence) and **Jina CLIP v2** (non-commercial): licences don't allow a paid product.

## Consequences

- The app needs a SentencePiece tokenizer for SigLIP's text model, written in-app and checked against Transformers.js output (no runtime dependency on Transformers.js).
- Install size grows by ~407 MB (fetched at install like the face models, SHA-256 pinned; bundled in packaged installers per spec 0002).
- Expected first analysis: ~54 ms of model time per photo, plus decoding.
