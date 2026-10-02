package com.wordsduck2.app

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.os.Bundle
import android.util.Base64
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * 应用内的 1:1 头像裁剪界面。
 *
 * 为什么不调系统裁剪器（这段结论是实测出来的，别删）：
 *   最初是发 `com.android.camera.action.CROP` 让系统相册裁。这台 MIUI（HyperOS）上
 *   `com.miui.gallery.crop.CropperActivity` 确实能被拉起、界面也正常，但**它什么都不写**：
 *     · onActivityResult 收到 RESULT_OK；
 *     · 输出文件不存在（或预创建后仍是 0 字节）；
 *     · 返回的 Intent 里没有任何 extras。
 *   试过的写法都不行：只给 content uri、只给 file:// 路径、return-data=true、
 *   显式 grantUriPermission、源图复制到自己的 FileProvider……全是 0 字节
 *   （有一次 return-data=true 还直接回了 RESULT_CANCELED）。
 *
 *   也**不是权限问题**：预创建的输出文件能被正常创建（说明我们有写权限），
 *   MIUI 相册自身也持有 MANAGE_EXTERNAL_STORAGE。所以「加存储权限」解决不了它 ——
 *   加了只是多一个用不上的权限。
 *
 * 结论：系统裁剪器不是稳定契约（AOSP 里根本没声明这个 action），
 *   在个别 ROM 上表现不可预期。这里改为自己实现 —— 行为完全可控、
 *   不依赖任何第三方应用、也不需要任何权限。
 *
 * 交互：单指拖动、双指缩放，中间那个白色方框就是最终结果（1:1）。
 */
class CropActivity : Activity() {

    companion object {
        const val EXTRA_SRC = "src_path"
        const val EXTRA_OUT_W = "out_w"
        const val EXTRA_OUT_H = "out_h"
        const val EXTRA_DATA_URL = "data_url"

        private const val MAX_OUT = 512
    }

    private lateinit var cropView: CropView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val srcPath = intent.getStringExtra(EXTRA_SRC)
        val bmp = if (srcPath != null) BitmapFactory.decodeFile(srcPath) else null
        if (bmp == null) {
            // 图读不出来：直接回取消，交给调用方走降级路径
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        cropView = CropView(bmp)

        /* 界面用代码搭，不写 layout xml：这个界面元素很少（一个裁剪区 +
           两个按钮 + 一行提示），而且颜色要与 app 的 M3 令牌保持一致，
           放在代码里反而一眼能看清对应关系。
           底色用深色遮罩 —— 这是裁剪界面的通行做法：四周压暗、中间留亮，
           用户一眼就知道哪块会被留下。 */
        val root = FrameLayout(this).apply {
            setBackgroundColor(0xFF121316.toInt())
        }

        root.addView(
            cropView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )

        // 底部按钮栏
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }

        val cancel = makeButton("取消", 0x33FFFFFF, 0xFFFFFFFF.toInt()) {
            setResult(RESULT_CANCELED)
            finish()
        }
        val confirm = makeButton("确定", 0xFF0B57D0.toInt(), 0xFFFFFFFF.toInt()) {
            finishWithResult()
        }
        cancel.layoutParams = LinearLayout.LayoutParams(0, dp(52), 1f).apply {
            marginEnd = dp(12)
        }
        confirm.layoutParams = LinearLayout.LayoutParams(0, dp(52), 1f)

        bar.addView(cancel)
        bar.addView(confirm)

        root.addView(
            bar,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.BOTTOM
            )
        )

        // 顶部提示
        val hint = TextView(this).apply {
            text = "拖动调整位置，双指缩放"
            setTextColor(0xB3FFFFFF.toInt())
            textSize = 14f
            gravity = android.view.Gravity.CENTER
            setPadding(dp(16), dp(28), dp(16), dp(16))
        }
        root.addView(
            hint,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.TOP
            )
        )

        setContentView(root)
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun makeButton(text: String, bg: Int, fg: Int, onClick: () -> Unit): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(fg)
            textSize = 16f
            gravity = android.view.Gravity.CENTER
            // 全圆角胶囊，和 app 里的按钮一致
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(bg)
                cornerRadius = dp(26).toFloat()
            }
            isClickable = true
            setOnClickListener { onClick() }
        }
    }

    /** 把当前裁剪切块编码成 data URL 回传。 */
    private fun finishWithResult() {
        val outW = intent.getIntExtra(EXTRA_OUT_W, MAX_OUT).coerceIn(64, MAX_OUT)
        val outH = intent.getIntExtra(EXTRA_OUT_H, MAX_OUT).coerceIn(64, MAX_OUT)

        val url = try {
            val square = cropView.renderSquare()
            val scaled = Bitmap.createScaledBitmap(square, outW, outH, true)
            val bos = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, 85, bos)
            if (scaled !== square) square.recycle()
            "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
        } catch (e: Exception) {
            ""
        }

        if (url.isEmpty()) {
            setResult(RESULT_CANCELED)
        } else {
            setResult(RESULT_OK, Intent().putExtra(EXTRA_DATA_URL, url))
        }
        finish()
    }

    /**
     * 裁剪区：把图片按「填满」比例铺进中间的正方形，允许拖动与缩放，
     * 白色方框标出最终会被裁走的部分。
     *
     * 写成 inner class 是为了能直接拿外层 Activity 当 Context ——
     * View 必须有个真 Context，早先图省事写成 `View(null)`，
     * 结果是 `Unable to start activity ... CropView.<init>` 直接闪退。
     */
    private inner class CropView(private val src: Bitmap) : View(this@CropActivity) {

        /** 最终裁剪区（正方形），在 onSizeChanged 里算好 */
        private val frame = RectF()

        /** 图片的当前变换（相对 frame 的坐标系） */
        private val matrix = Matrix()

        private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
        private val framePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 4f
            color = 0xFFFFFFFF.toInt()
        }
        private val scrim = Paint().apply { color = 0xB3000000.toInt() }

        /** 图片「填满」frame 所需的最小缩放 */
        private var minScale = 1f
        private var curScale = 1f
        private var curDx = 0f
        private var curDy = 0f

        private var lastX = 0f
        private var lastY = 0f
        private var lastDist = 0f
        private var inited = false

        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            super.onSizeChanged(w, h, oldw, oldh)
            val side = min(w, h) * 0.78f
            val cx = w / 2f
            val cy = h / 2f
            frame.set(cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)

            // 首次布局时把图居中、按「填满」缩放
            minScale = max(frame.width() / src.width, frame.height() / src.height)
            if (!inited) {
                curScale = minScale
                curDx = frame.centerX() - src.width * curScale / 2f
                curDy = frame.centerY() - src.height * curScale / 2f
                inited = true
            }

            clamp()
            apply()
            invalidate()
        }

        /** 图片必须始终盖满 frame，否则会露出空白 */
        private fun clamp() {
            curScale = max(curScale, minScale)
            val w = src.width * curScale
            val h = src.height * curScale

            /* 夹取范围的上界是 frame.left / frame.top，下界是 frame.right - w 之类。
               当图刚好「填满」frame 时两边会重合，而浮点误差可能让下界比上界
               大那么一丁点（实测报过 maximum 118.80002 is less than minimum 118.80005），
               coerceIn 遇到空区间会直接抛 IllegalArgumentException。
               所以这里显式判一次：区间无效就取中点（等价于「不偏移」）。 */
            curDx = coerceInSafe(curDx, frame.right - w, frame.left)
            curDy = coerceInSafe(curDy, frame.bottom - h, frame.top)
        }

        /** 把 v 夹进 [lo, hi]；lo > hi（浮点误差导致的空区间）时取两者中点。 */
        private fun coerceInSafe(v: Float, lo: Float, hi: Float): Float {
            return if (lo > hi) (lo + hi) / 2f else v.coerceIn(lo, hi)
        }

        private fun apply() {
            matrix.reset()
            matrix.postScale(curScale, curScale)
            matrix.postTranslate(curDx, curDy)
        }

        override fun onDraw(canvas: Canvas) {
            // 先把整张图按当前变换画出来
            canvas.save()
            canvas.clipRect(frame)
            canvas.drawBitmap(src, matrix, paint)
            canvas.restore()

            // 四周压暗，只留中间方框亮着
            canvas.save()
            canvas.clipRect(frame, android.graphics.Region.Op.DIFFERENCE)
            canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), scrim)
            canvas.restore()

            canvas.drawRect(frame, framePaint)
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    lastX = event.x; lastY = event.y; lastDist = 0f
                }
                MotionEvent.ACTION_POINTER_DOWN -> {
                    lastDist = spacing(event)
                }
                MotionEvent.ACTION_MOVE -> {
                    if (event.pointerCount >= 2) {
                        val d = spacing(event)
                        if (lastDist > 0f && d > 0f) {
                            val old = curScale
                            curScale *= (d / lastDist)
                            /* 以 frame 中心为锚点缩放：不这么做的话，
                               缩放会让图往左上角飘，手感很怪。 */
                            val k = curScale / old
                            curDx = frame.centerX() + (curDx - frame.centerX()) * k
                            curDy = frame.centerY() + (curDy - frame.centerY()) * k
                        }
                        lastDist = d
                    } else {
                        curDx += event.x - lastX
                        curDy += event.y - lastY
                        lastX = event.x; lastY = event.y
                    }
                    clamp(); apply(); invalidate()
                }
                MotionEvent.ACTION_POINTER_UP -> lastDist = 0f
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    lastDist = 0f
                }
            }
            return true
        }

        private fun spacing(e: MotionEvent): Float {
            if (e.pointerCount < 2) return 0f
            val dx = e.getX(0) - e.getX(1)
            val dy = e.getY(0) - e.getY(1)
            return kotlin.math.sqrt(dx * dx + dy * dy)
        }

        /**
         * 把 frame 覆盖的那块图裁出来，输出正方形。
         * 用 Matrix.mapRect 反推源矩形，避免手写一遍坐标换算。
         */
        fun renderSquare(): Bitmap {
            val inv = Matrix()
            if (!matrix.invert(inv)) {
                // 理论上不会发生（scale 永不为 0），兜底直接缩小整张
                val side = min(src.width, src.height)
                return Bitmap.createBitmap(
                    src, (src.width - side) / 2, (src.height - side) / 2, side, side
                )
            }
            val r = RectF(frame)
            inv.mapRect(r)

            // 夹进图片范围，防止越界（拖动夹取理论上已保证，这里再兜一层）
            r.left = r.left.coerceIn(0f, src.width.toFloat())
            r.top = r.top.coerceIn(0f, src.height.toFloat())
            r.right = r.right.coerceIn(0f, src.width.toFloat())
            r.bottom = r.bottom.coerceIn(0f, src.height.toFloat())

            val w = max(1f, abs(r.width()))
            val h = max(1f, abs(r.height()))
            return Bitmap.createBitmap(
                src, r.left.toInt(), r.top.toInt(),
                min(w.toInt(), src.width - r.left.toInt()),
                min(h.toInt(), src.height - r.top.toInt())
            )
        }
    }
}
