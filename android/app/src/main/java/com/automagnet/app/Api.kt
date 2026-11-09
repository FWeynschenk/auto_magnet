package com.automagnet.app

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** Server address and session, kept across launches. */
object Prefs {
    private lateinit var sp: SharedPreferences

    fun init(ctx: Context) {
        sp = ctx.getSharedPreferences("amagnet", Context.MODE_PRIVATE)
    }

    var server: String
        get() = sp.getString("server", "") ?: ""
        set(v) = sp.edit().putString("server", v.trim().trimEnd('/')).apply()

    var token: String?
        get() = sp.getString("token", null)
        set(v) = sp.edit().putString("token", v).apply()

    var username: String?
        get() = sp.getString("username", null)
        set(v) = sp.edit().putString("username", v).apply()

    /** "admin" runs the downloader and sees the Manage tab; "viewer" only watches. */
    var role: String?
        get() = sp.getString("role", null)
        set(v) = sp.edit().putString("role", v).apply()

    val isAdmin get() = role == "admin"

    var wifiOnly: Boolean
        get() = sp.getBoolean("wifi_only", true)
        set(v) = sp.edit().putBoolean("wifi_only", v).apply()

    /** Play the original file when this phone decodes everything in it, rather than the web version. */
    var directPlay: Boolean
        get() = sp.getBoolean("direct_play", true)
        set(v) = sp.edit().putBoolean("direct_play", v).apply()

    /** Subtitle look on this device: size "s" "m" "l" "xl", background "system" "none" "shaded" "solid". */
    var cueSize: String
        get() = sp.getString("cue_size", "m") ?: "m"
        set(v) = sp.edit().putString("cue_size", v).apply()
    var cueBg: String
        get() = sp.getString("cue_bg", "system") ?: "system"
        set(v) = sp.edit().putString("cue_bg", v).apply()

    fun string(key: String): String? = sp.getString(key, null)
    fun putString(key: String, v: String?) = sp.edit().putString(key, v).apply()
}

class AuthException(msg: String) : IOException(msg)
class ApiException(val status: Int, msg: String) : IOException(msg)

object Api {
    // coerceInputValues: a null where a field has a default takes the default,
    // so one odd row (a movie without a TMDB id) can't fail a whole list.
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true; coerceInputValues = true }
    private val JSON_TYPE = "application/json".toMediaType()

    /**
     * The session token goes only to the auto_magnet server — never to the
     * image hosts posters come from.
     */
    private val auth = Interceptor { chain ->
        val req = chain.request()
        val token = Prefs.token
        val server = Prefs.server
        val ours = server.isNotEmpty() && req.url.toString().startsWith(server)
        chain.proceed(if (ours && token != null) req.newBuilder().header("Authorization", "Bearer $token").build() else req)
    }

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .addInterceptor(auth)
        .build()

    fun abs(path: String) = if (path.startsWith("http")) path else Prefs.server + path

    private suspend fun call(method: String, path: String, body: String? = null): String = withContext(Dispatchers.IO) {
        val rb = body?.toRequestBody(JSON_TYPE) ?: if (method == "POST" || method == "PUT") "".toRequestBody(JSON_TYPE) else null
        val req = Request.Builder().url(abs(path)).method(method, rb).build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string() ?: ""
            if (res.code == 401) throw AuthException("Signed out — please sign in again")
            if (!res.isSuccessful) {
                val msg = runCatching { json.parseToJsonElement(text).let { (it as? kotlinx.serialization.json.JsonObject)?.get("error")?.toString()?.trim('"') } }.getOrNull()
                throw ApiException(res.code, msg ?: "HTTP ${res.code}")
            }
            text
        }
    }

    private suspend inline fun <reified T> get(path: String): T = json.decodeFromString(call("GET", path))

    suspend fun login(server: String, username: String, password: String): LoginResponse {
        Prefs.server = server
        val body = json.encodeToString(mapOf("username" to username, "password" to password, "client" to "Android app"))
        val r: LoginResponse = json.decodeFromString(call("POST", "/api/auth/login", body))
        Prefs.token = r.token
        Prefs.username = r.user.username
        Prefs.role = r.user.role
        return r
    }

    suspend fun logout() {
        runCatching { call("POST", "/api/auth/logout") }
        Prefs.token = null
    }

    /** Refresh the role: sessions from before the Manage tab never stored one. */
    suspend fun me(): User = get<User>("/api/auth/me").also { Prefs.role = it.role }

    suspend fun home(): Home = get("/api/watch/home")
    suspend fun movies(): List<Item> = get("/api/watch/movies")
    suspend fun shows(): List<ShowSummary> = get("/api/watch/shows")
    suspend fun show(id: Int): ShowDetail = get("/api/watch/shows/$id")
    /** play = true only from the player: it starts a conversion the item still needs. */
    suspend fun item(kind: String, id: Int, play: Boolean = false): ItemDetail =
        get("/api/watch/items/$kind/$id" + if (play) "?play=1" else "")
    suspend fun playback(kind: String, id: Int): Playback = get("/api/watch/items/$kind/$id/playback")
    /** soon = true: for a download or the next episode — ahead of background work, without stopping anything. */
    suspend fun prepare(kind: String, id: Int, soon: Boolean = false): Playback =
        json.decodeFromString(call("POST", "/api/watch/items/$kind/$id/prepare", "{\"soon\":$soon}"))

    /** What was picked in the player, remembered for the whole show (or film). */
    suspend fun choice(kind: String, id: Int, audioLang: String? = null, subLang: String? = null, subOff: Boolean? = null) {
        call("POST", "/api/watch/items/$kind/$id/choice", obj("audio_lang" to audioLang, "sub_lang" to subLang, "sub_off" to subOff))
    }

    suspend fun shiftSub(kind: String, id: Int, sub: String, offsetMs: Int) {
        call("POST", "/api/watch/items/$kind/$id/subtitles/$sub/shift", obj("offsetMs" to offsetMs))
    }
    /** Reads the whole soundtrack on the server: can take a minute or two. */
    suspend fun syncSub(kind: String, id: Int, sub: String): SyncResult =
        json.decodeFromString(call("POST", "/api/watch/items/$kind/$id/subtitles/$sub/sync"))
    suspend fun restoreSub(kind: String, id: Int, sub: String): Boolean =
        json.parseToJsonElement(call("POST", "/api/watch/items/$kind/$id/subtitles/$sub/restore"))
            .let { (it as? JsonObject)?.get("restored")?.toString() == "true" }

    /** Admin: the web version only (the original stays and keeps seeding), or everything. */
    suspend fun deleteWebVersion(kind: String, id: Int) { call("DELETE", "/api/watch/items/$kind/$id/web") }
    suspend fun deleteFromDisk(kind: String, id: Int) { call("DELETE", "/api/watch/items/$kind/$id") }
    /** Admin: not the right video. Deleted, never picked again for it, another looked for. */
    suspend fun wrongVideo(kind: String, id: Int, reason: String, pack: Boolean = false) {
        call("POST", "/api/watch/items/$kind/$id/wrong", obj("reason" to reason, "pack" to pack))
    }

    suspend fun setWatched(kind: String, id: Int, watched: Boolean): Progress =
        json.decodeFromString(call("POST", "/api/watch/progress/$kind/$id/watched", """{"watched":$watched}"""))

    suspend fun syncProgress(items: List<PendingProgress>): List<ProgressRow> =
        json.decodeFromString(call("POST", "/api/watch/progress/sync", json.encodeToString(SyncRequest(items))))

    // ─── Managing the library (admin only) ─────────────────────────────────────

    /** A JSON object from pairs, leaving out nulls. */
    private fun obj(vararg pairs: Pair<String, Any?>): String = buildJsonObject {
        for ((k, v) in pairs) when (v) {
            null -> {}
            is String -> put(k, v)
            is Number -> put(k, v)
            is Boolean -> put(k, v)
            is JsonElement -> put(k, v)
            else -> error("Unsupported value for $k")
        }
    }.toString()

    suspend fun trackedMovies(): List<AdminMovie> = get("/api/movies")
    suspend fun trackedShows(): List<AdminShow> = get("/api/shows")
    suspend fun targets(): List<TxTarget> = get("/api/settings/targets")
    suspend fun searchTmdb(q: String): List<TmdbResult> = get("/api/search/tmdb?q=" + URLEncoder.encode(q, "UTF-8"))

    suspend fun addMovie(tmdbId: Int, quality: String, mode: String, target: String?): AdminMovie =
        json.decodeFromString(call("POST", "/api/movies", obj(
            "tmdb_id" to tmdbId, "quality" to quality, "mode" to mode, "transmission_target" to target,
        )))

    suspend fun addShow(tmdbId: Int, quality: String, mode: String, startSeason: Int, startEpisode: Int, preferPack: Boolean, target: String?): AdminShow =
        json.decodeFromString(call("POST", "/api/shows", obj(
            "tmdb_id" to tmdbId, "quality" to quality, "mode" to mode, "start_season" to startSeason,
            "start_episode" to startEpisode, "prefer_season_pack" to (if (preferPack) 1 else 0), "transmission_target" to target,
        )))

    suspend fun updateMovie(id: Int, vararg fields: Pair<String, Any?>): AdminMovie =
        json.decodeFromString(call("PUT", "/api/movies/$id", obj(*fields)))
    suspend fun updateShow(id: Int, vararg fields: Pair<String, Any?>): AdminShow =
        json.decodeFromString(call("PUT", "/api/shows/$id", obj(*fields)))
    suspend fun deleteMovie(id: Int) { call("DELETE", "/api/movies/$id") }
    suspend fun deleteShow(id: Int) { call("DELETE", "/api/shows/$id") }
    suspend fun redoMovie(id: Int) { call("POST", "/api/movies/$id/redo") }
    suspend fun redoEpisode(showId: Int, epId: Int) { call("POST", "/api/shows/$showId/episodes/$epId/redo") }
    suspend fun skipEpisode(showId: Int, epId: Int) { call("POST", "/api/shows/$showId/episodes/$epId/skip") }
    suspend fun refreshTmdb(showId: Int) { call("POST", "/api/shows/$showId/refresh-tmdb") }

    suspend fun preview(p: PickFor, refresh: Boolean, query: String?): PreviewResponse =
        json.decodeFromString(call("POST", "/api/search/preview", obj(
            "type" to p.type, "tmdb_id" to p.tmdbId, "quality" to p.quality, "season" to p.season, "episode" to p.episode,
            "movie_id" to (if (p.type == "movie") p.mediaId else null), "episode_id" to p.episodeId,
            "refresh" to refresh, "query" to query?.takeIf { it.isNotBlank() },
        )))

    /** Hand one release to Transmission. The candidate goes back as the server sent it. */
    suspend fun grab(p: PickFor, c: Candidate): GrabResponse =
        json.decodeFromString(call("POST", "/api/search/grab", obj(
            "torrent" to json.encodeToJsonElement(Candidate.serializer(), c),
            "media_id" to p.mediaId, "media_type" to p.type, "season" to p.season, "episode" to p.episode,
        )))

    /** Save a subtitle to a local file, for playing a download offline. */
    suspend fun downloadTo(path: String, dest: File) = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(abs(path)).build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw ApiException(res.code, "HTTP ${res.code}")
            dest.parentFile?.mkdirs()
            val tmp = File(dest.path + ".tmp")
            tmp.outputStream().use { out -> res.body!!.byteStream().copyTo(out) }
            tmp.renameTo(dest)
        }
    }
}
