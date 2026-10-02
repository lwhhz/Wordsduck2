# assets/tts/chunks/ —— 离线语音包分片（本仓库未收录）

这个目录里的 24 个 `.js` 文件是 **Piper 神经语音包**，总共约 **162 MB**，
因为体积太大没有放进仓库。缺了它们不影响基本使用 —— 见下面「缺了会怎样」。

## 这里本来装的是什么

网页版的内置语音引擎（`assets/tts-local.js` + `assets/tts/boot.js`）把三份
二进制资源 base64 展开成分片，绕过 `file://` 下取不到本地文件的限制：

| 来源 | 原始大小 | 用途 |
|---|---|---|
| `en_GB-cori-high.onnx`（Piper 音色，fp32） | 114 MB | 声学模型 |
| `ort-wasm-simd-threaded.wasm`（onnxruntime-web） | 11 MB | 推理后端 |
| `piper_phonemize.wasm` + `.pruned.data`（espeak-ng） | 1.6 MB | 音素化 |

切片与校验信息都在 `assets/tts/manifest.json` 里，每个分片的 sha256 前 16 位
都记着，所以补回来之后可以逐片核对。

## 缺了会怎样

**不会报错，会自动降级。** `app.js` 的引擎选择顺序是：

```
local（内置语音包）→ native（安卓壳子的系统 TTS）→ web（Web Speech）→ none
```

内置语音包装不上就往下走：

- **APK 里完全无所谓** —— Android 壳子本来就不用内置语音包，
  打包时 `syncWebAssets` 会把 `tts-local.js` 和 `tts/boot.js` 两个
  `<script>` 直接删掉，走系统 TTS（`TtsBridge.kt`）。见 `android/BUILD-ANDROID.md`。
- **浏览器里** 会退到 Web Speech API（Chrome / Edge 可用，音色由系统决定）。
  断网且系统没装语音包时，「发音」按钮会自己隐藏 —— 这是设计好的行为，
  不是坏了。

## 怎么补回来

上游模型是公开的，但**本仓库没有现成的转换脚本**（当初生成分片的那一步没留下来）。
要恢复需要自己做一遍：

1. 取原始资源：

   | 需要的东西 | 从哪来 |
   |---|---|
   | `en_GB-cori-high.onnx` | [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) |
   | `ort-wasm-simd-threaded.wasm` | onnxruntime-web |
   | `piper_phonemize.wasm` / `piper_phonemize.pruned.data` | piper 的 phonemize 构建产物 |

2. 切片。每片原始数据 **6291456 字节**（`manifest.json` 的 `chunkRaw`；
   `boot.js` 里也有同名的 `CHUNK` 常量），文件名形如 `名字.两位序号.js`。

3. 每片包成一个 `.js`，**两行**：

   ```js
   /* en_GB-cori-high.onnx bytes 0-6291456 of 114219352 */
   window.WCTTS._blit("voice_gb",0,"<base64…>");
   ```

   第一行只是给人看的注释；第二行才是载荷 ——
   `_blit(blob 名字, 分片序号, base64)`，`blob 名字` 与分片序号都要和
   `manifest.json` 的 `blobs[].name` / 顺序对得上。

4. 逐片核对 `manifest.json` 里记的 `sha256_16`（前 16 位）。

> 注意 `ortglue.js` 不是二进制分片，它是 onnxruntime 的 emscripten glue，
> 内部把 `import.meta.url` 改写成了 `__ORT_GLUE_BASE__` —— 这份要单独处理，
> 不能照上面的切片方式生成。

> 如果你只是想在浏览器里听发音，**不用折腾这个**：
> 用 Chrome / Edge 打开就能走 Web Speech，或者直接装 APK 走系统 TTS。
