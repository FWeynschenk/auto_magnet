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
)

@Serializable
data class Subtitle(
    val id: String,
    val label: String,
    val lang: String? = null,
    val url: String? = null,
    val available: Boolean = true,
    val default: Boolean = false,
    val forced: Boolean = false,
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
