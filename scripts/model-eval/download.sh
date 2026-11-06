#!/bin/bash
# Downloads candidate content-search models and the COCO val2017 benchmark into a
# dev cache outside the repo (spec 0002 model evaluation). Resumable; re-run safely.
set -euo pipefail
CACHE="${PHOTO_LIBRARY_EVAL_CACHE:-$HOME/.cache/photo-library-eval}"
mkdir -p "$CACHE"

fetch() { # repo file...
  local repo=$1; shift
  for f in "$@"; do
    local out="$CACHE/models/$repo/$f"
    mkdir -p "$(dirname "$out")"
    if [ -s "$out" ] && [ ! -f "$out.part" ]; then continue; fi
    echo "↓ $repo/$f"
    touch "$out.part"
    curl -sSfL -C - -o "$out" "https://huggingface.co/$repo/resolve/main/$f"
    rm -f "$out.part"
  done
}

CFG="config.json preprocessor_config.json tokenizer.json tokenizer_config.json special_tokens_map.json"
for r in Xenova/clip-vit-base-patch32 Xenova/clip-vit-base-patch16; do
  fetch $r $CFG vocab.json merges.txt onnx/vision_model.onnx onnx/vision_model_fp16.onnx onnx/vision_model_quantized.onnx onnx/text_model.onnx onnx/text_model_fp16.onnx onnx/text_model_quantized.onnx
done
# Large models: half precision is the reference (full precision is 1.2-1.7 GB per half).
fetch Xenova/clip-vit-large-patch14 $CFG vocab.json merges.txt onnx/vision_model_fp16.onnx onnx/vision_model_quantized.onnx onnx/text_model_fp16.onnx onnx/text_model_quantized.onnx
fetch Xenova/siglip-base-patch16-224 $CFG spiece.model onnx/vision_model.onnx onnx/vision_model_fp16.onnx onnx/vision_model_quantized.onnx onnx/text_model.onnx onnx/text_model_fp16.onnx onnx/text_model_quantized.onnx
fetch onnx-community/siglip2-base-patch16-224-ONNX $CFG tokenizer.model onnx/vision_model.onnx onnx/vision_model_fp16.onnx onnx/vision_model_quantized.onnx onnx/text_model_fp16.onnx onnx/text_model_quantized.onnx
fetch nomic-ai/nomic-embed-vision-v1.5 config.json preprocessor_config.json onnx/model.onnx onnx/model_fp16.onnx onnx/model_quantized.onnx
fetch nomic-ai/nomic-embed-text-v1.5 config.json tokenizer.json tokenizer_config.json special_tokens_map.json onnx/model.onnx onnx/model_fp16.onnx onnx/model_quantized.onnx

# COCO val2017: 5,000 images with 5 captions each (images ~780 MB, captions in the annotations zip).
mkdir -p "$CACHE/coco"
cd "$CACHE/coco"
[ -d val2017 ] || { echo "↓ COCO val2017 images"; curl -sSfL -C - -o val2017.zip http://images.cocodataset.org/zips/val2017.zip && unzip -q val2017.zip && rm val2017.zip; }
# Captions (benchmark) and object labels (calibrate.mjs: the content-match threshold).
[ -f annotations/captions_val2017.json ] && [ -f annotations/instances_val2017.json ] || { echo "↓ COCO captions and labels"; curl -sSfL -C - -o ann.zip http://images.cocodataset.org/annotations/annotations_trainval2017.zip && unzip -q -o ann.zip 'annotations/captions_val2017.json' 'annotations/instances_val2017.json' && rm ann.zip; }
echo "done: $(du -sh "$CACHE" | cut -f1) in $CACHE"
