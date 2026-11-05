@file:OptIn(UnstableApi::class)

package com.automagnet.app

import android.app.Notification
import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheKeyFactory
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.offline.DefaultDownloadIndex
import androidx.media3.exoplayer.offline.DefaultDownloaderFactory
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.exoplayer.offline.DownloadNotificationHelper
import androidx.media3.exoplayer.offline.DownloadRequest
import androidx.media3.exoplayer.offline.DownloadService
import androidx.media3.exoplayer.scheduler.Requirements
import androidx.media3.exoplayer.scheduler.Scheduler
import java.io.File
import java.util.concurrent.Executors

/**
 * Offline copies, kept by Media3's DownloadManager in a cache of their own.
 *
 * The cache is keyed by URL *path*, not the full URL, so a download made at
 * http://192.168.0.102:62201 still plays when the app is pointed at the same
 * server under another address (a VPN name, say) — or at nothing at all.
 *
 * Playback reads through the same cache: a downloaded item plays from disk,
 * anything else streams from the server without filling the cache.
 */
object Downloads {
    const val CHANNEL = "downloads"
    lateinit var manager: DownloadManager
        private set
    private lateinit var cache: SimpleCache
    private lateinit var appContext: Context
    private var notifications: DownloadNotificationHelper? = null

    private val keyFactory = CacheKeyFactory { spec ->
        spec.key ?: (spec.uri.path + (spec.uri.query?.let { "?$it" } ?: ""))
    }

    fun init(ctx: Context) {
        appContext = ctx.applicationContext
        val db = StandaloneDatabaseProvider(appContext)
        val dir = File(appContext.getExternalFilesDir(null) ?: appContext.filesDir, "downloads")
        cache = SimpleCache(dir, NoOpCacheEvictor(), db)
        val writeFactory = CacheDataSource.Factory()
            .setCache(cache)
            .setCacheKeyFactory(keyFactory)
            .setUpstreamDataSourceFactory(OkHttpDataSource.Factory(Api.http))
        manager = DownloadManager(appContext, DefaultDownloadIndex(db), DefaultDownloaderFactory(writeFactory, Executors.newFixedThreadPool(3)))
        manager.maxParallelDownloads = 2
        applyRequirements()
    }

    fun applyRequirements() {
        manager.requirements = Requirements(if (Prefs.wifiOnly) Requirements.NETWORK_UNMETERED else Requirements.NETWORK)
    }

    /** For the player: cache first (downloads), then the network. Never writes. */
    fun playbackFactory(ctx: Context): DataSource.Factory = CacheDataSource.Factory()
        .setCache(cache)
        .setCacheKeyFactory(keyFactory)
        .setUpstreamDataSourceFactory(DefaultDataSource.Factory(ctx, OkHttpDataSource.Factory(Api.http)))
        .setCacheWriteDataSinkFactory(null)
        .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)

    fun idFor(kind: String, id: Int) = "$kind:$id"

    fun get(kind: String, id: Int): Download? = runCatching { manager.downloadIndex.getDownload(idFor(kind, id)) }.getOrNull()

    fun all(): List<Download> {
        val out = mutableListOf<Download>()
        runCatching {
            manager.downloadIndex.getDownloads().use { c -> while (c.moveToNext()) out.add(c.download) }
        }
        return out.sortedByDescending { it.startTimeMs }
    }

    fun meta(d: Download): DownloadMeta? =
        runCatching { Api.json.decodeFromString(DownloadMeta.serializer(), String(d.request.data)) }.getOrNull()

    private fun subsDir(kind: String, id: Int) = File(appContext.filesDir, "subs/$kind-$id")

    /**
     * Queue a download. Subtitles are small and fetched straight away, so they
     * are there even if the video finishes while the app is closed.
     */
    suspend fun start(ctx: Context, detail: ItemDetail) {
        val dl = detail.playback.download ?: throw IllegalStateException(
            if (detail.playback.mode == "preparing") "Still being prepared on the server — try again when it's done"
            else detail.playback.error ?: "Not available for download"
        )
        val dir = subsDir(detail.kind, detail.id)
        val subs = detail.subtitles.filter { it.available && it.url != null }.mapNotNull { s ->
            val f = File(dir, "${s.id}.vtt")
            runCatching { Api.downloadTo(s.url!!, f) }.getOrNull() ?: return@mapNotNull null
            LocalSubtitle(s.id, s.label, s.lang, f.absolutePath, s.default)
        }
        val meta = DownloadMeta(detail.asItem(), dl.type, subs)
        val request = DownloadRequest.Builder(idFor(detail.kind, detail.id), Uri.parse(Api.abs(dl.url)))
            .setMimeType(if (dl.type == "hls") MimeTypes.APPLICATION_M3U8 else null)
            .setData(Api.json.encodeToString(DownloadMeta.serializer(), meta).toByteArray())
            .build()
        DownloadService.sendAddDownload(ctx, AmDownloadService::class.java, request, false)
    }

    fun remove(ctx: Context, kind: String, id: Int) {
        DownloadService.sendRemoveDownload(ctx, AmDownloadService::class.java, idFor(kind, id), false)
        subsDir(kind, id).deleteRecursively()
    }

    fun notification(ctx: Context, downloads: List<Download>, notMet: Int): Notification {
        val helper = notifications ?: DownloadNotificationHelper(ctx, CHANNEL).also { notifications = it }
        return helper.buildProgressNotification(ctx, R.drawable.ic_download, null, null, downloads, notMet)
    }
}

class AmDownloadService : DownloadService(
    1, DEFAULT_FOREGROUND_NOTIFICATION_UPDATE_INTERVAL, Downloads.CHANNEL, R.string.downloads_channel, 0,
) {
    override fun getDownloadManager(): DownloadManager = Downloads.manager
    override fun getScheduler(): Scheduler? = null
    override fun getForegroundNotification(downloads: MutableList<Download>, notMetRequirements: Int): Notification =
        Downloads.notification(this, downloads, notMetRequirements)
}
