@file:OptIn(UnstableApi::class)

package com.automagnet.app

import android.content.Context
import android.hardware.display.DisplayManager
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.view.Display
import androidx.annotation.OptIn
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi

/**
 * Whether this phone can play an original file itself.
 *
 * A browser can't play HEVC, 10-bit video, MKV or AC-3, which is why the
 * server converts or repackages them. A phone often can: then the app plays
 * the original straight away — no waiting for a conversion, and none started
 * on the server — at full quality. Only when every part is supported: the
 * container, the video (codec, profile, size), HDR only on an HDR screen, and
 * the audio track that would play.
 */
object DirectPlay {
    private val codecs by lazy { MediaCodecList(MediaCodecList.REGULAR_CODECS) }

    private val CONTAINERS = setOf("matroska", "mov", "mp4", "mpegts", "webm")

    private fun videoMime(codec: String?) = when (codec) {
        "h264" -> MimeTypes.VIDEO_H264
        "hevc" -> MimeTypes.VIDEO_H265
        "av1" -> MimeTypes.VIDEO_AV1
        "vp9" -> MimeTypes.VIDEO_VP9
        "mpeg2video" -> MimeTypes.VIDEO_MPEG2
        else -> null
    }

    private fun audioMime(codec: String?) = when (codec) {
        "aac" -> MimeTypes.AUDIO_AAC
        "mp3" -> MimeTypes.AUDIO_MPEG
        "ac3" -> MimeTypes.AUDIO_AC3
        "eac3" -> MimeTypes.AUDIO_E_AC3
        "dts" -> MimeTypes.AUDIO_DTS
        "truehd" -> MimeTypes.AUDIO_TRUEHD
        "opus" -> MimeTypes.AUDIO_OPUS
        "vorbis" -> MimeTypes.AUDIO_VORBIS
        "flac" -> MimeTypes.AUDIO_FLAC
        else -> null
    }

    private fun decodes(format: MediaFormat) = runCatching { codecs.findDecoderForFormat(format) != null }.getOrDefault(false)

    private fun tenBit(v: OriginalVideo) = v.pixFmt?.contains("10") == true

    private fun videoOk(v: OriginalVideo): Boolean {
        val mime = videoMime(v.codec) ?: return false
        // 4:2:2 and 4:4:4 have no phone decoder; 10-bit H.264 neither.
        val pix = v.pixFmt ?: ""
        if (pix.isNotEmpty() && !pix.startsWith("yuv420p") && !pix.startsWith("yuvj420p")) return false
        if (v.codec == "h264" && tenBit(v)) return false
        val f = MediaFormat.createVideoFormat(mime, v.width ?: 1920, v.height ?: 1080)
        if (v.codec == "hevc") {
            f.setInteger(MediaFormat.KEY_PROFILE,
                if (tenBit(v)) MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10 else MediaCodecInfo.CodecProfileLevel.HEVCProfileMain)
        }
        return decodes(f)
    }

    private fun audioOk(a: OriginalAudio): Boolean {
        val mime = audioMime(a.codec) ?: return false
        return decodes(MediaFormat.createAudioFormat(mime, 48000, (a.channels ?: 2).coerceIn(1, 8)))
    }

    /** HDR video shown on an SDR screen looks washed out: only where the screen does HDR10/HLG. */
    @Suppress("DEPRECATION")
    private fun hdrScreen(ctx: Context, kind: String): Boolean {
        val d = ctx.getSystemService(DisplayManager::class.java)?.getDisplay(Display.DEFAULT_DISPLAY) ?: return false
        val types = d.hdrCapabilities?.supportedHdrTypes ?: return false
        val want = if (kind == "arib-std-b67") Display.HdrCapabilities.HDR_TYPE_HLG else Display.HdrCapabilities.HDR_TYPE_HDR10
        return want in types
    }

    /** Why not, or null when this phone plays the original. */
    fun whyNot(ctx: Context, o: Original?, preferredAudio: List<String>): String? {
        if (o == null) return "no original"
        if (!Prefs.directPlay) return "turned off"
        if (o.container !in CONTAINERS) return "${o.container} container"
        if (!videoOk(o.video)) return "${o.video.codec} ${o.video.pixFmt ?: ""} video".trim()
        o.video.hdr?.let { if (!hdrScreen(ctx, it)) return "HDR on a screen without it" }
        // The track that would play: the first in a wanted language, else the first ordinary one.
        val ordinary = o.audio.filter { !it.extra }.ifEmpty { o.audio }
        val first = preferredAudio.firstNotNullOfOrNull { l -> ordinary.firstOrNull { it.lang == l } } ?: ordinary.firstOrNull()
        if (first != null && !audioOk(first)) return "${first.codec} audio"
        return null
    }
}
