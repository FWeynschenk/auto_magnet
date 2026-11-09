package com.automagnet.app

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class User(val id: Int, val username: String, val role: String)

@Serializable
data class LoginResponse(val user: User, val token: String)

@Serializable
data class Progress(
    val position: Double = 0.0,
    val duration: Double? = null,
    val watched: Boolean = false,
    @SerialName("updated_at") val updatedAt: String? = null,
)

/** A card in a listing: a movie or an episode. */
@Serializable
data class Item(
    val kind: String,
    val id: Int,
    val title: String,
    @SerialName("poster_url") val posterUrl: String? = null,
    val duration: Double? = null,
    val plan: String? = null,
    @SerialName("web_state") val webState: String? = null,
    val progress: Progress? = null,
    val year: Int? = null,
    @SerialName("show_id") val showId: Int? = null,
    @SerialName("show_title") val showTitle: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    @SerialName("still_url") val stillUrl: String? = null,
    val overview: String? = null,
    val status: String? = null,
    @SerialName("air_date") val airDate: String? = null,
) {
    val key get() = "$kind:$id"
    val code get() = if (season != null && episode != null) "S%02dE%02d".format(season, episode) else ""
    val heading get() = if (kind == "episode") showTitle ?: title else title
    val subheading get() = if (kind == "episode") "$code · $title" else (year?.toString() ?: "")
}

@Serializable
data class Home(
    @SerialName("continue") val cont: List<Item> = emptyList(),
    val nextUp: List<Item> = emptyList(),
    val recent: List<Item> = emptyList(),
)

@Serializable
data class ShowSummary(
    val id: Int,
    val title: String,
    @SerialName("poster_url") val posterUrl: String? = null,
    val available: Int = 0,
    val unwatched: Int = 0,
)

@Serializable
data class ShowInfo(val id: Int, val title: String, @SerialName("poster_url") val posterUrl: String? = null)

@Serializable
data class Season(val season: Int, val episodes: List<Item>)

@Serializable
data class ShowDetail(val show: ShowInfo, val seasons: List<Season>)

@Serializable
data class DownloadInfo(val type: String, val url: String, val size: Long? = null)

@Serializable
data class Playback(
    val mode: String,
    val url: String? = null,
    val complete: Boolean? = null,
    val download: DownloadInfo? = null,
    val plan: String? = null,
    val reason: String? = null,
    val state: String? = null,
    val progress: Double? = null,
    val error: String? = null,
    /** Why a queued web version hasn't started: "space" (with bytes) or "busy". */
    val waiting: Waiting? = null,
)

@Serializable
data class Waiting(val reason: String, val free: Double? = null, val need: Double? = null, val running: Int? = null)

@Serializable
data class Subtitle(
    val id: String,
    val label: String,
    val lang: String? = null,
    val url: String? = null,
    val available: Boolean = true,
    val default: Boolean = false,
    val forced: Boolean = false,
    /** A .srt beside the video: its timing can be saved, auto-synced and restored. */
    val editable: Boolean = false,
    /** "file" (beside the video) or "embedded" (in it: a phone playing the original reads those itself). */
    val source: String? = null,
)

/** Where a show's intro sits in this episode, in seconds. */
@Serializable
data class Intro(val start: Double, val end: Double)

/** What the original file holds, so the app can tell whether this phone plays it itself. */
@Serializable
data class Original(
    val url: String,
    val container: String? = null,
    val size: Long? = null,
    val video: OriginalVideo,
    val audio: List<OriginalAudio> = emptyList(),
)

@Serializable
data class OriginalVideo(
    val codec: String? = null,
    val profile: String? = null,
    @SerialName("pix_fmt") val pixFmt: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val hdr: String? = null,
)

@Serializable
data class OriginalAudio(
    val codec: String? = null,
    val channels: Int? = null,
    val lang: String? = null,
    val name: String? = null,
    /** Commentary or audio description: never the one that has to play. */
    val extra: Boolean = false,
)

/** POST …/subtitles/:id/sync */
@Serializable
data class SyncResult(
    val applied: Boolean = false,
    val reason: String? = null,
    val offsetMs: Double? = null,
    val ratio: Double? = null,
    val refined: Boolean = false,
    val maxCorrectionMs: Double? = null,
)

/** Everything about one item, as GET /api/watch/items/:kind/:id returns it. */
@Serializable
data class ItemDetail(
    val kind: String,
    val id: Int,
    val title: String,
    @SerialName("poster_url") val posterUrl: String? = null,
    val duration: Double? = null,
    val progress: Progress? = null,
    val year: Int? = null,
    @SerialName("show_id") val showId: Int? = null,
    @SerialName("show_title") val showTitle: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    @SerialName("still_url") val stillUrl: String? = null,
    val overview: String? = null,
    val playback: Playback,
    val subtitles: List<Subtitle> = emptyList(),
    val next: Item? = null,
    /** This account's audio languages to try, in order: a remembered pick first. */
    @SerialName("audio_langs") val audioLangs: List<String> = emptyList(),
    val intro: Intro? = null,
    /** The end credits, when found: the next episode is offered from there. */
    val credits: Intro? = null,
    val original: Original? = null,
    /** Admins: the release it came from. */
    val release: String? = null,
    /** Admins: how many items the same torrent downloaded (a pack when over 1). */
    @SerialName("pack_size") val packSize: Int? = null,
) {
    fun asItem() = Item(
        kind = kind, id = id, title = title, posterUrl = posterUrl, duration = duration, progress = progress,
        year = year, showId = showId, showTitle = showTitle, season = season, episode = episode,
        stillUrl = stillUrl, overview = overview,
    )
}

@Serializable
data class ProgressRow(
    val kind: String,
    val id: Int,
    val position: Double = 0.0,
    val duration: Double? = null,
    val watched: Boolean = false,
    @SerialName("updated_at") val updatedAt: String? = null,
)

/** A position reached on this device, waiting to be uploaded. */
@Serializable
data class PendingProgress(
    val kind: String,
    val id: Int,
    val position: Double,
    val duration: Double? = null,
    val at: Long,
    val watched: Boolean? = null,
)

@Serializable
data class SyncRequest(val items: List<PendingProgress>)

/** What is stored with a download, so it can be listed and played offline. */
@Serializable
data class DownloadMeta(
    val item: Item,
    val type: String,                       // "file" | "hls"
    val subtitles: List<LocalSubtitle> = emptyList(),
)

@Serializable
data class LocalSubtitle(val id: String, val label: String, val lang: String? = null, val path: String, val default: Boolean = false)

// ─── Managing the library (admin) ─────────────────────────────────────────────

/** A tracked movie, as GET /api/movies returns it. */
@Serializable
data class AdminMovie(
    val id: Int,
    @SerialName("tmdb_id") val tmdbId: Int = 0,
    val title: String,
    val year: Int? = null,
    @SerialName("poster_url") val posterUrl: String? = null,
    val status: String = "pending",
    val quality: String = "1080p",
    val mode: String = "auto",
    val progress: Int? = 0,
    @SerialName("release_date") val releaseDate: String? = null,
    @SerialName("last_error") val lastError: String? = null,
    /** The release it was downloaded from, so a wrong one is easy to spot. */
    @SerialName("release_title") val releaseTitle: String? = null,
    @SerialName("transmission_target") val target: String? = null,
) {
    /** Manual mode, waiting for someone to pick a release. */
    val needsChoice get() = mode == "manual" && status == "pending"
}

@Serializable
data class AdminEpisode(
    val id: Int,
    val season: Int,
    val episode: Int,
    val status: String = "pending",
    val progress: Int? = 0,
    @SerialName("air_date") val airDate: String? = null,
    @SerialName("last_error") val lastError: String? = null,
    /** The release it was downloaded from, so a wrong one is easy to spot. */
    @SerialName("release_title") val releaseTitle: String? = null,
) {
    val code get() = "S%02dE%02d".format(season, episode)
}

/** A tracked show with its episodes, as GET /api/shows returns it. */
@Serializable
data class AdminShow(
    val id: Int,
    @SerialName("tmdb_id") val tmdbId: Int = 0,
    val title: String,
    @SerialName("poster_url") val posterUrl: String? = null,
    val active: Int = 1,
    val quality: String = "1080p",
    val mode: String = "auto",
    @SerialName("prefer_season_pack") val preferPack: Int? = 0,
    @SerialName("show_status") val showStatus: String? = null,
    @SerialName("transmission_target") val target: String? = null,
    val episodes: List<AdminEpisode> = emptyList(),
) {
    /** The episode a manual-mode show waits on, if any: the scheduler queues one at a time. */
    val waitingOn: AdminEpisode?
        get() = if (mode == "manual") episodes.filter { it.status == "pending" }.minWithOrNull(compareBy({ it.season }, { it.episode })) else null

    fun count(status: String) = episodes.count { it.status == status }
}

@Serializable
data class TmdbResult(
    @SerialName("tmdb_id") val tmdbId: Int = 0,
    val type: String,                       // "movie" | "tv"
    val title: String,
    val year: String? = null,
    @SerialName("poster_url") val posterUrl: String? = null,
    val overview: String? = null,
)

/** One release in the torrent picker. Every accepted row has a magnet. */
@Serializable
data class Candidate(
    val title: String,
    val source: String? = null,
    val indexer: String? = null,
    val seeders: Int = 0,
    val size: Long = 0,
    val magnet: String? = null,
    @SerialName("download_url") val downloadUrl: String? = null,
    @SerialName("info_hash") val infoHash: String? = null,
    @SerialName("file_count") val fileCount: Int = 0,
    @SerialName("_quality") val quality: String? = null,
    @SerialName("_score") val score: Double? = null,
    @SerialName("_warnings") val warnings: List<String> = emptyList(),
    @SerialName("_mirrors") val mirrors: Int? = null,
    @SerialName("_reason") val reason: String? = null,
)

@Serializable
data class PreviewResponse(
    val results: List<Candidate> = emptyList(),
    val rejected: List<Candidate> = emptyList(),
    val cached: Boolean = false,
    @SerialName("cache_age_ms") val cacheAgeMs: Long? = null,
    val query: String? = null,
)

@Serializable
data class GrabResponse(
    val success: Boolean = false,
    @SerialName("torrent_id") val torrentId: Int? = null,
    val quarantined: Boolean = false,
    val duplicate: Boolean = false,
)

@Serializable
data class TxTarget(val name: String, val host: String? = null)

/** What the torrent picker is choosing for. */
data class PickFor(
    val type: String,                       // "movie" | "show"
    val tmdbId: Int,
    val mediaId: Int,                       // the movie's id, or the show's
    val title: String,
    val quality: String,
    val season: Int? = null,
    val episode: Int? = null,
    val episodeId: Int? = null,
)
