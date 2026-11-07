@file:OptIn(UnstableApi::class)

package com.automagnet.app

import android.app.Activity
import android.app.AlertDialog
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
import android.graphics.drawable.GradientDrawable
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
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
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
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.PlayerView
import androidx.media3.ui.SubtitleView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

/**
 * Full-screen playback. A finished download plays from the device; anything
 * else streams — the original file itself when this phone decodes everything
 * in it (see DirectPlay), else the server's web version. The position is saved
 * every ten seconds and whenever playback stops, to ProgressStore first and
 * the server when it can be reached.
 *
 * The account's audio languages pick the track, and what is picked here (an
 * audio track, a subtitle language, or subtitles off) is remembered on the
 * server for the whole show. "Skip intro" shows while a detected intro plays.
 * The ⋯ button holds the subtitle look, subtitle timing, and whether to play
 * originals.
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
        private val CUE_SIZES = linkedMapOf("s" to "Small", "m" to "Medium", "l" to "Large", "xl" to "Extra large")
        private val CUE_SCALE = mapOf("s" to 0.8f, "m" to 1f, "l" to 1.3f, "xl" to 1.65f)
        private val CUE_BGS = linkedMapOf("system" to "As the phone's caption settings", "none" to "None (outlined text)", "shaded" to "Shaded", "solid" to "Solid")
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var view: PlayerView
    private lateinit var message: TextView
    private lateinit var skipIntro: Button
    private lateinit var menu: TextView
    private var player: ExoPlayer? = null
    private var kind = ""
    private var id = 0
    private var duration: Double? = null
    private var next: Item? = null
    private var lastSaved = -1.0
    private val pipSupported by lazy { packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE) }

    // What is playing, for the menus.
    private var detail: ItemDetail? = null
    private var streamUri: Uri? = null
    private var streamMime: String? = null
    private var streamSubs: List<Subtitle> = emptyList()   // side-loaded, when streaming
    private var offsetMs = 0
    private var reselectSub: String? = null                // after a reload: the subtitle to show again
    private var remembered: Pair<String?, String?>? = null // (audio, text) as last reported or first seen

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
        val dp = resources.displayMetrics.density
        skipIntro = Button(this).apply {
            text = "Skip intro ▸"
            setTextColor(Color.WHITE)
            isAllCaps = false
            background = GradientDrawable().apply {
                setColor(0xD9141414.toInt()); cornerRadius = 6 * dp; setStroke((1 * dp).toInt(), 0x80FFFFFF.toInt())
            }
            setPadding((18 * dp).toInt(), 0, (18 * dp).toInt(), 0)
            visibility = View.GONE
            setOnClickListener { detail?.intro?.let { player?.seekTo((it.end * 1000).toLong()) } }
        }
        menu = TextView(this).apply {
            text = "⋯"
            textSize = 26f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding((16 * dp).toInt(), (4 * dp).toInt(), (16 * dp).toInt(), (8 * dp).toInt())
            contentDescription = "More"
            visibility = View.GONE
            setOnClickListener { showMenu() }
        }
        view.setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { v -> menu.visibility = v })
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(message, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        root.addView(skipIntro, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, (48 * dp).toInt(), Gravity.BOTTOM or Gravity.END).apply {
            setMargins(0, 0, (24 * dp).toInt(), (96 * dp).toInt())
        })
        root.addView(menu, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END).apply {
            setMargins(0, (12 * dp).toInt(), (12 * dp).toInt(), 0)
        })
        setContentView(root)
        immersive()
        applyCueStyle()
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
        handler.removeCallbacks(introWatch)
        save(force = true)
        player?.release()
        player = null
        view.player = null
        kind = newKind
        id = newId
        duration = null
        next = null
        lastSaved = -1.0
        detail = null
        streamSubs = emptyList()
        offsetMs = 0
        remembered = null
        skipIntro.visibility = View.GONE
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
        if (isInPictureInPictureMode) {
            view.hideController()
            skipIntro.visibility = View.GONE
            menu.visibility = View.GONE
        } else immersive()
    }

    private fun immersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // ─── Loading ─────────────────────────────────────────────────────────────

    private fun subConfig(s: Subtitle, offset: Int = 0): MediaItem.SubtitleConfiguration {
        val url = Api.abs(s.url!!) + if (offset != 0) "?offset=$offset" else ""
        return MediaItem.SubtitleConfiguration.Builder(Uri.parse(url))
            .setMimeType(MimeTypes.TEXT_VTT).setLanguage(s.lang).setLabel(s.label).setId(s.id)
            .setSelectionFlags(if (s.default) C.SELECTION_FLAG_DEFAULT else 0).build()
    }

    private suspend fun load() {
        val dl = Downloads.get(kind, id)
        if (dl != null && dl.state == Download.STATE_COMPLETED) {
            val meta = Downloads.meta(dl)
            duration = meta?.item?.duration
            // Online, find the next episode, the intro and the languages in the background; offline, just play.
            scope.launch { runCatching { Api.item(kind, id) }.onSuccess { detail = it; next = it.next; preferAudio(it.audioLangs) } }
            val subs = meta?.subtitles?.map { s ->
                MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(File(s.path)))
                    .setMimeType(MimeTypes.TEXT_VTT).setLanguage(s.lang).setLabel(s.label).setId(s.id)
                    .setSelectionFlags(if (s.default) C.SELECTION_FLAG_DEFAULT else 0).build()
            } ?: emptyList()
            val resume = ProgressStore.resumeFor(kind, id, null)
            play(dl.request.uri, dl.request.mimeType, subs, resume, meta?.subtitles?.firstOrNull { it.default }?.lang, emptyList())
            return
        }

        // First without ?play=1: a phone that plays the original starts no conversion.
        var d = try {
            Api.item(kind, id)
        } catch (e: Exception) {
            message.text = "Can't reach the server: ${e.message}"
            return
        }
        val why = DirectPlay.whyNot(this, d.original, d.audioLangs)
        if (why == null && d.original != null) {
            detail = d
            duration = d.duration
            next = d.next
            // Text tracks inside the file are read by the player itself; only those beside it are added.
            streamSubs = d.subtitles.filter { it.available && it.url != null && it.source == "file" }
            streamUri = Uri.parse(Api.abs(d.original!!.url))
            streamMime = null
            val def = d.subtitles.firstOrNull { it.default }
            play(streamUri!!, null, streamSubs.map { subConfig(it) }, ProgressStore.resumeFor(kind, id, d.progress),
                def?.lang, d.audioLangs, subsOff = def == null)
            return
        }

        d = try { Api.item(kind, id, play = true) } catch (e: Exception) { message.text = "Can't reach the server: ${e.message}"; return }
        detail = d
        duration = d.duration
        next = d.next
        var pb = d.playback
        if (pb.mode == "unavailable") { message.text = pb.error ?: "This can't be played"; return }
        // Converting on the server: wait for the first part, then start — the
        // rest keeps arriving while it plays.
        var misses = 0
        while (pb.mode == "preparing") {
            if (pb.state == "failed") { message.text = "The server couldn't convert this:\n${pb.error ?: ""}"; return }
            val pct = ((pb.progress ?: 0.0) * 100).toInt()
            val w = pb.waiting
            message.text = when {
                w?.reason == "space" ->
                    "The server's disk is nearly full, so this can't be prepared right now.\n" +
                        "${gb(w.free)} free — it needs about ${gb(w.need)}. It starts by itself once there is room."
                pb.state == "queued" && (w?.running ?: 0) > 0 ->
                    "Waiting for ${w!!.running} other conversion${if (w.running == 1) "" else "s"} someone asked for…"
                pb.state == "queued" -> "Starting…"
                else -> "Preparing for playback… $pct%\n${pb.reason ?: ""}"
            } + if (misses >= 3) "\n\nCan't reach the server — still trying…" else ""
            delay(2000)
            pb = runCatching { Api.playback(kind, id) }
                .onSuccess { misses = 0 }
                .getOrElse { misses++; pb }
        }
        streamSubs = d.subtitles.filter { it.available && it.url != null }
        streamUri = Uri.parse(Api.abs(pb.url!!))
        streamMime = if (pb.mode == "hls") MimeTypes.APPLICATION_M3U8 else null
        val def = d.subtitles.firstOrNull { it.default }
        play(streamUri!!, streamMime, streamSubs.map { subConfig(it) }, ProgressStore.resumeFor(kind, id, d.progress),
            def?.lang, d.audioLangs, subsOff = def == null)
    }

    private fun preferAudio(langs: List<String>) {
        val p = player ?: return
        if (langs.isEmpty()) return
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().setPreferredAudioLanguages(*langs.toTypedArray()).build()
    }

    private fun play(
        uri: Uri, mime: String?, subs: List<MediaItem.SubtitleConfiguration>, resumeAt: Double, subLang: String?,
        audioLangs: List<String>, subsOff: Boolean = false,
    ) {
        message.visibility = View.GONE
        val p = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(Downloads.playbackFactory(this)))
            .build()
        player = p
        view.player = p
        val params = p.trackSelectionParameters.buildUpon()
        if (audioLangs.isNotEmpty()) params.setPreferredAudioLanguages(*audioLangs.toTypedArray())
        if (subLang != null) params.setPreferredTextLanguage(subLang)
        // Off on purpose (remembered, or nothing in this person's languages): a
        // track flagged default inside the file mustn't switch them on. The
        // subtitle menu turns them on again.
        if (subsOff && subLang == null) params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        p.trackSelectionParameters = params.build()
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
            override fun onTracksChanged(tracks: Tracks) = onTracks(tracks)
            override fun onPlayerError(error: PlaybackException) {
                message.visibility = View.VISIBLE
                message.text = "Playback failed: ${error.errorCodeName}"
            }
        })
        p.prepare()
        p.playWhenReady = true
        handler.post(ticker)
        handler.post(introWatch)
    }

    // ─── Remembering what was picked ─────────────────────────────────────────

    private fun selected(tracks: Tracks, type: Int) =
        tracks.groups.firstOrNull { it.type == type && it.isSelected }?.let { g ->
            (0 until g.length).firstOrNull { g.isTrackSelected(it) }?.let { g.getTrackFormat(it) }
        }

    /** The side-loaded subtitle a text format is, if it is one of ours. */
    private fun ourSub(formatId: String?): Subtitle? =
        formatId?.let { fid -> streamSubs.firstOrNull { fid == it.id || fid.endsWith(":${it.id}") } }

    private fun onTracks(tracks: Tracks) {
        if (tracks.groups.isEmpty()) return
        // After a reload for a subtitle offset: show the same subtitle again.
        reselectSub?.let { want ->
            val g = tracks.groups.firstOrNull { it.type == C.TRACK_TYPE_TEXT && (0 until it.length).any { i -> ourSub(it.getTrackFormat(i).id)?.id == want } }
            if (g != null) {
                val i = (0 until g.length).first { ourSub(g.getTrackFormat(it).id)?.id == want }
                player?.let { p ->
                    p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                        .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, i)).build()
                }
            }
            reselectSub = null
            return
        }
        val audio = selected(tracks, C.TRACK_TYPE_AUDIO)?.language
        val text = selected(tracks, C.TRACK_TYPE_TEXT)?.language
        val now = audio to text
        val before = remembered
        remembered = now
        // The first selection is the player's own (from the preferences): not a pick.
        if (before == null || before == now) return
        val d = detail ?: return
        scope.launch(Dispatchers.IO) {
            runCatching {
                when {
                    before.first != now.first && now.first != null -> Api.choice(d.kind, d.id, audioLang = now.first)
                }
                when {
                    before.second == now.second -> {}
                    now.second == null -> Api.choice(d.kind, d.id, subOff = true)
                    else -> Api.choice(d.kind, d.id, subLang = now.second)
                }
            }
        }
    }

    // ─── Skip intro ──────────────────────────────────────────────────────────

    private val introWatch = object : Runnable {
        override fun run() {
            val intro = detail?.intro
            val p = player
            val t = (p?.currentPosition ?: 0) / 1000.0
            val show = intro != null && p != null && !isInPictureInPictureMode && t >= intro.start && t < intro.end - 2
            skipIntro.visibility = if (show) View.VISIBLE else View.GONE
            handler.postDelayed(this, 500)
        }
    }

    // ─── The ⋯ menu ──────────────────────────────────────────────────────────

    private fun currentSub(): Subtitle? = player?.let { ourSub(selected(it.currentTracks, C.TRACK_TYPE_TEXT)?.id) }

    private fun showMenu() {
        val entries = mutableListOf<Pair<String, () -> Unit>>()
        entries += "Subtitle size: ${CUE_SIZES[Prefs.cueSize]}" to { pick("Subtitle size", CUE_SIZES, Prefs.cueSize) { Prefs.cueSize = it; applyCueStyle() } }
        entries += "Subtitle background: ${CUE_BGS[Prefs.cueBg]}" to { pick("Subtitle background", CUE_BGS, Prefs.cueBg) { Prefs.cueBg = it; applyCueStyle() } }
        if (currentSub() != null) entries += "Subtitle timing…" to { timing() }
        entries += (if (Prefs.directPlay) "Play originals when this phone can: on" else "Play originals when this phone can: off") to {
            Prefs.directPlay = !Prefs.directPlay
            Toast.makeText(this, if (Prefs.directPlay) "On — from the next thing you open" else "Off — the server's web version from now on", Toast.LENGTH_SHORT).show()
        }
        AlertDialog.Builder(this)
            .setItems(entries.map { it.first }.toTypedArray()) { _, i -> entries[i].second() }
            .show()
    }

    private fun pick(title: String, options: Map<String, String>, current: String, set: (String) -> Unit) {
        val keys = options.keys.toList()
        AlertDialog.Builder(this).setTitle(title)
            .setSingleChoiceItems(options.values.toTypedArray(), keys.indexOf(current).coerceAtLeast(0)) { dlg, i -> set(keys[i]); dlg.dismiss() }
            .show()
    }

    /** Subtitle look: size on top of, or instead of, the phone's own caption settings. */
    private fun applyCueStyle() {
        val sv: SubtitleView = view.subtitleView ?: return
        val scale = CUE_SCALE[Prefs.cueSize] ?: 1f
        if (scale == 1f) sv.setUserDefaultTextSize() else sv.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * scale)
        val white = Color.WHITE
        when (Prefs.cueBg) {
            "none" -> sv.setStyle(CaptionStyleCompat(white, Color.TRANSPARENT, Color.TRANSPARENT, CaptionStyleCompat.EDGE_TYPE_OUTLINE, Color.BLACK, null))
            "shaded" -> sv.setStyle(CaptionStyleCompat(white, 0x8C000000.toInt(), Color.TRANSPARENT, CaptionStyleCompat.EDGE_TYPE_NONE, Color.BLACK, null))
            "solid" -> sv.setStyle(CaptionStyleCompat(white, 0xE6000000.toInt(), Color.TRANSPARENT, CaptionStyleCompat.EDGE_TYPE_NONE, Color.BLACK, null))
            else -> sv.setUserDefaultStyle()
        }
    }

    /**
     * Earlier/later by a quarter second, live: the subtitle is fetched again
     * shifted (the player can't move cues itself), at the same position. Then
     * Save writes the shift into the file; Auto-sync aligns it to the audio on
     * the server; Restore puts the original back.
     */
    private fun timing() {
        val sub = currentSub() ?: return
        val dp = resources.displayMetrics.density
        val label = TextView(this).apply { textSize = 18f; gravity = Gravity.CENTER; setPadding(0, (8 * dp).toInt(), 0, (8 * dp).toInt()) }
        var dlg: AlertDialog? = null
        // The left button is Save once there is an offset to save, Restore before.
        fun show() {
            label.text = "%+.2f s".format(offsetMs / 1000.0)
            dlg?.getButton(AlertDialog.BUTTON_NEGATIVE)?.text = if (offsetMs != 0) "Save to file" else "Restore"
        }
        show()
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        fun btn(t: String, f: () -> Unit) = Button(this).apply { text = t; isAllCaps = false; setOnClickListener { f() } }
        row.addView(btn("− ¼ s") { offsetMs -= 250; show(); reload(sub) })
        row.addView(label, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(btn("+ ¼ s") { offsetMs += 250; show(); reload(sub) })
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((20 * dp).toInt(), (12 * dp).toInt(), (20 * dp).toInt(), 0)
            addView(TextView(context).apply { text = "Earlier or later until the lines match the speech."; setTextColor(0xFF9CA3AF.toInt()) })
            addView(row)
        }
        val b = AlertDialog.Builder(this).setTitle(sub.label).setView(box).setPositiveButton("Done", null)
        if (sub.editable) {
            b.setNeutralButton("Auto-sync") { _, _ -> serverTiming(sub, "Syncing to the audio… (a minute or two)") { Api.syncSub(kind, id, sub.id).let { r ->
                if (r.applied) "Synced: moved %.2f s%s".format((r.offsetMs ?: 0.0) / 1000, if (r.refined) ", fine-tuned along the way" else "") else "Left as is: ${r.reason}"
            } } }
            b.setNegativeButton("Restore") { _, _ ->
                if (offsetMs != 0) {
                    val ms = offsetMs
                    serverTiming(sub, "Saving…") { Api.shiftSub(kind, id, sub.id, ms); "Saved: %+.2f s".format(ms / 1000.0) }
                } else {
                    serverTiming(sub, "Restoring…") { if (Api.restoreSub(kind, id, sub.id)) "Original timing restored" else "Nothing to restore — this file was never changed" }
                }
            }
        }
        dlg = b.show()
        show()
    }

    /** A timing change on the server; then the subtitle is fetched again, unshifted. */
    private fun serverTiming(sub: Subtitle, busy: String, work: suspend () -> String) {
        Toast.makeText(this, busy, Toast.LENGTH_SHORT).show()
        scope.launch {
            val msg = runCatching { work() }.getOrElse { "Failed: ${it.message}" }
            offsetMs = 0
            reload(sub)
            Toast.makeText(this@PlayerActivity, msg, Toast.LENGTH_LONG).show()
        }
    }

    /** The same media at the same position, with the subtitles fetched again (shifted by offsetMs). */
    private fun reload(sub: Subtitle) {
        val p = player ?: return
        val uri = streamUri ?: return
        val pos = p.currentPosition
        val playing = p.playWhenReady
        reselectSub = sub.id
        p.setMediaItem(
            MediaItem.Builder().setUri(uri).setMimeType(streamMime)
                .setSubtitleConfigurations(streamSubs.map { subConfig(it, if (it.id == sub.id) offsetMs else 0) }).build(),
            pos,
        )
        p.prepare()
        p.playWhenReady = playing
    }

    // ─── Progress ────────────────────────────────────────────────────────────

    private fun gb(b: Double?) = if (b == null) "?" else "%.1f GB".format(b / 1e9)

    private val ticker = object : Runnable {
        override fun run() {
            save(force = false)
            prepareNext()
            handler.postDelayed(this, 10_000)
        }
    }

    private var nextRequested: Int? = null

    /**
     * Four-fifths of the way in, ask the server to prepare the next episode,
     * so it's ready when this one ends. Once per episode; harmless for files
     * that need no preparing.
     */
    private fun prepareNext() {
        val p = player ?: return
        val n = next ?: return
        if (nextRequested == n.id) return
        val dur = p.duration.takeIf { it > 0 && it != C.TIME_UNSET }?.let { it / 1000.0 } ?: duration ?: return
        if (p.currentPosition / 1000.0 / dur < 0.8) return
        nextRequested = n.id
        scope.launch(Dispatchers.IO) {
            runCatching { Api.prepare(n.kind, n.id, soon = true) }.onFailure { nextRequested = null }
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
        handler.removeCallbacks(introWatch)
        save(force = true)
        player?.release()
        player = null
        // Let the last upload finish even though the screen is gone.
        CoroutineScope(Dispatchers.IO).launch { ProgressStore.sync() }
        scope.cancel()
        super.onDestroy()
    }
}
