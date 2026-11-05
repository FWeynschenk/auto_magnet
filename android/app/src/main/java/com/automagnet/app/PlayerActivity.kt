@file:OptIn(UnstableApi::class)

package com.automagnet.app

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Rational
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

/**
 * Full-screen playback. A finished download plays from the device; anything
 * else streams. The position is saved every ten seconds and whenever playback
 * stops, to ProgressStore first and the server when it can be reached.
 *
 * Leaving the app while something plays shrinks it to picture-in-picture
 * (automatically on Android 12+, on Home/Recents before that). The PiP window
 * has rewind, play/pause and forward buttons. There is only ever one player
 * (singleTask): opening another item while one plays in PiP switches it.
 */
class PlayerActivity : Activity() {
    companion object {
        fun start(ctx: Context, kind: String, id: Int) {
            ctx.startActivity(Intent(ctx, PlayerActivity::class.java).putExtra("kind", kind).putExtra("id", id))
        }
        private const val ACTION_PIP = "com.automagnet.app.PIP_CONTROL"
        private const val CMD_REWIND = 1
        private const val CMD_TOGGLE = 2
        private const val CMD_FORWARD = 3
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var view: PlayerView
    private lateinit var message: TextView
    private var player: ExoPlayer? = null
    private var kind = ""
    private var id = 0
    private var duration: Double? = null
    private var next: Item? = null
    private var lastSaved = -1.0
    private val pipSupported by lazy { packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE) }

    private val pipReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val p = player ?: return
            when (intent.getIntExtra("cmd", 0)) {
                CMD_REWIND -> p.seekTo((p.currentPosition - 10_000).coerceAtLeast(0))
                CMD_TOGGLE -> if (p.isPlaying) p.pause() else p.play()
                CMD_FORWARD -> p.seekTo(p.currentPosition + 10_000)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        kind = intent.getStringExtra("kind") ?: return finish()
        id = intent.getIntExtra("id", 0)
        ContextCompat.registerReceiver(this, pipReceiver, IntentFilter(ACTION_PIP), ContextCompat.RECEIVER_NOT_EXPORTED)

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        view = PlayerView(this).apply {
            setShowSubtitleButton(true)
            setShowNextButton(false)
            setShowPreviousButton(false)
            keepScreenOn = true
        }
        message = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 16f
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            text = "Loading…"
        }
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(message, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        setContentView(root)
        immersive()
        scope.launch { load() }
    }

    /** Another item opened while this one plays (in PiP, usually): switch to it. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val k = intent.getStringExtra("kind") ?: return
        val i = intent.getIntExtra("id", 0)
        if (k == kind && i == id) return
        switchTo(k, i)
    }

    private fun switchTo(newKind: String, newId: Int) {
        handler.removeCallbacks(ticker)
        save(force = true)
        player?.release()
        player = null
        view.player = null
        kind = newKind
        id = newId
        duration = null
        next = null
        lastSaved = -1.0
        message.text = "Loading…"
        message.visibility = View.VISIBLE
        scope.launch { load() }
    }

    // ─── Picture-in-picture ──────────────────────────────────────────────────

    private fun pipAction(cmd: Int, icon: Int, title: String) = RemoteAction(
        Icon.createWithResource(this, icon), title, title,
        PendingIntent.getBroadcast(
            this, cmd, Intent(ACTION_PIP).setPackage(packageName).putExtra("cmd", cmd),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        ),
    )

    private fun pipParams(): PictureInPictureParams {
        val p = player
        val playing = p?.isPlaying == true
        val b = PictureInPictureParams.Builder()
            .setAspectRatio(aspect(p?.videoSize))
            .setActions(listOf(
                pipAction(CMD_REWIND, android.R.drawable.ic_media_rew, "Back 10 seconds"),
                if (playing) pipAction(CMD_TOGGLE, android.R.drawable.ic_media_pause, "Pause")
                else pipAction(CMD_TOGGLE, android.R.drawable.ic_media_play, "Play"),
                pipAction(CMD_FORWARD, android.R.drawable.ic_media_ff, "Forward 10 seconds"),
            ))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Going home while it plays shrinks it, without waiting for onUserLeaveHint.
            b.setAutoEnterEnabled(playing).setSeamlessResizeEnabled(true)
        }
        return b.build()
    }

    /** The video's shape, within the range Android accepts for PiP. */
    private fun aspect(size: VideoSize?): Rational {
        if (size == null || size.width == 0 || size.height == 0) return Rational(16, 9)
        val w = (size.width * size.pixelWidthHeightRatio).toInt().coerceAtLeast(1)
        val ratio = w.toFloat() / size.height
        return when {
            ratio > 2.39f -> Rational(239, 100)
            ratio < 1 / 2.39f -> Rational(100, 239)
            else -> Rational(w, size.height)
        }
    }

    private fun updatePip() {
        if (pipSupported) runCatching { setPictureInPictureParams(pipParams()) }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Android 12+ enters on its own (setAutoEnterEnabled); before that, here.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && pipSupported && player?.isPlaying == true) {
            runCatching { enterPictureInPictureMode(pipParams()) }
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        view.useController = !isInPictureInPictureMode
        if (isInPictureInPictureMode) view.hideController() else immersive()
    }

    private fun immersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private suspend fun load() {
        val dl = Downloads.get(kind, id)
        if (dl != null && dl.state == Download.STATE_COMPLETED) {
            val meta = Downloads.meta(dl)
            duration = meta?.item?.duration
            // Online, find the next episode in the background; offline, just play.
            scope.launch { next = runCatching { Api.item(kind, id).next }.getOrNull() }
            val subs = meta?.subtitles?.map { s ->
                MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(File(s.path)))
                    .setMimeType(MimeTypes.TEXT_VTT).setLanguage(s.lang).setLabel(s.label).setId(s.id)
                    .setSelectionFlags(if (s.default) C.SELECTION_FLAG_DEFAULT else 0).build()
            } ?: emptyList()
            val resume = ProgressStore.resumeFor(kind, id, null)
            play(dl.request.uri, dl.request.mimeType, subs, resume, meta?.subtitles?.firstOrNull { it.default }?.lang)
            return
        }

        val detail = try {
            Api.item(kind, id)
        } catch (e: Exception) {
            message.text = "Can't reach the server: ${e.message}"
            return
        }
        duration = detail.duration
        next = detail.next
        var pb = detail.playback
        if (pb.mode == "unavailable") { message.text = pb.error ?: "This can't be played"; return }
        // Converting on the server: wait for the first part, then start — the
        // rest keeps arriving while it plays.
        while (pb.mode == "preparing") {
            if (pb.state == "failed") { message.text = "The server couldn't convert this:\n${pb.error ?: ""}"; return }
            val pct = ((pb.progress ?: 0.0) * 100).toInt()
            message.text = if (pb.state == "queued") "Waiting for the server to start converting…" else "Preparing for playback… $pct%\n${pb.reason ?: ""}"
            delay(2000)
            pb = runCatching { Api.playback(kind, id) }.getOrElse { pb }
        }
        val subs = detail.subtitles.filter { it.available && it.url != null }.map { s ->
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(Api.abs(s.url!!)))
                .setMimeType(MimeTypes.TEXT_VTT).setLanguage(s.lang).setLabel(s.label).setId(s.id)
                .setSelectionFlags(if (s.default) C.SELECTION_FLAG_DEFAULT else 0).build()
        }
        val resume = ProgressStore.resumeFor(kind, id, detail.progress)
        play(Uri.parse(Api.abs(pb.url!!)), if (pb.mode == "hls") MimeTypes.APPLICATION_M3U8 else null, subs, resume,
            detail.subtitles.firstOrNull { it.default }?.lang)
    }

    private fun play(uri: Uri, mime: String?, subs: List<MediaItem.SubtitleConfiguration>, resumeAt: Double, subLang: String?) {
        message.visibility = View.GONE
        val p = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(Downloads.playbackFactory(this)))
            .build()
        player = p
        view.player = p
        if (subLang != null) {
            p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().setPreferredTextLanguage(subLang).build()
        }
        p.setMediaItem(
            MediaItem.Builder().setUri(uri).setMimeType(mime).setSubtitleConfigurations(subs).build(),
            (resumeAt * 1000).toLong(),
        )
        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) {
                    save(force = true, ended = true)
                    next?.let { n -> switchTo(n.kind, n.id) }
                }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (!isPlaying) save(force = true)
                updatePip()
            }
            override fun onVideoSizeChanged(videoSize: VideoSize) = updatePip()
            override fun onPlayerError(error: PlaybackException) {
                message.visibility = View.VISIBLE
                message.text = "Playback failed: ${error.errorCodeName}"
            }
        })
        p.prepare()
        p.playWhenReady = true
        handler.post(ticker)
    }

    private val ticker = object : Runnable {
        override fun run() {
            save(force = false)
            handler.postDelayed(this, 10_000)
        }
    }

    private fun save(force: Boolean, ended: Boolean = false) {
        val p = player ?: return
        val pos = p.currentPosition / 1000.0
        val dur = p.duration.takeIf { it > 0 && it != C.TIME_UNSET }?.let { it / 1000.0 } ?: duration
        if (pos <= 0 || (!force && kotlin.math.abs(pos - lastSaved) < 5)) return
        lastSaved = pos
        ProgressStore.record(kind, id, if (ended && dur != null) dur else pos, dur, if (ended) true else null)
        scope.launch(Dispatchers.IO) { ProgressStore.sync() }
    }

    override fun onStop() {
        super.onStop()
        save(force = true)
        player?.pause()
        // Stopped while in PiP means the PiP window was closed: there is no
        // screen left to come back to.
        if (isInPictureInPictureMode) finish()
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(pipReceiver) }
        handler.removeCallbacks(ticker)
        save(force = true)
        player?.release()
        player = null
        // Let the last upload finish even though the screen is gone.
        CoroutineScope(Dispatchers.IO).launch { ProgressStore.sync() }
        scope.cancel()
        super.onDestroy()
    }
}
