package com.automagnet.app

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Watch progress on this device.
 *
 * Every position is written here first and uploaded when possible, so a film
 * watched on a plane still counts. Each entry keeps the moment it was reached;
 * the server keeps whichever report is newest, so uploading late never
 * overwrites progress made since on another device.
 *
 * The server's answer to each upload is kept too, so resume points and
 * watched marks are known offline.
 */
object ProgressStore {
    private const val PENDING = "progress_pending"
    private const val KNOWN = "progress_known"
    private val mutex = Mutex()

    private fun pending(): MutableMap<String, PendingProgress> =
        (Prefs.string(PENDING)?.let { runCatching { Api.json.decodeFromString(ListSerializer(PendingProgress.serializer()), it) }.getOrNull() } ?: emptyList())
            .associateBy { "${it.kind}:${it.id}" }.toMutableMap()

    private fun known(): MutableMap<String, ProgressRow> =
        (Prefs.string(KNOWN)?.let { runCatching { Api.json.decodeFromString(ListSerializer(ProgressRow.serializer()), it) }.getOrNull() } ?: emptyList())
            .associateBy { "${it.kind}:${it.id}" }.toMutableMap()

    private fun savePending(m: Map<String, PendingProgress>) =
        Prefs.putString(PENDING, Api.json.encodeToString(ListSerializer(PendingProgress.serializer()), m.values.toList()))

    private fun saveKnown(m: Map<String, ProgressRow>) =
        Prefs.putString(KNOWN, Api.json.encodeToString(ListSerializer(ProgressRow.serializer()), m.values.toList()))

    @Synchronized
    fun record(kind: String, id: Int, position: Double, duration: Double?, watched: Boolean? = null) {
        val m = pending()
        m["$kind:$id"] = PendingProgress(kind, id, position, duration, System.currentTimeMillis(), watched)
        savePending(m)
    }

    private val sqlTime = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }

    /** Where to resume: the newer of what this device reported and what the server said. */
    @Synchronized
    fun resumeFor(kind: String, id: Int, server: Progress?): Double {
        val local = pending()["$kind:$id"]
        val serverRow = server?.let { ProgressRow(kind, id, it.position, it.duration, it.watched, it.updatedAt) } ?: known()["$kind:$id"]
        val serverAt = serverRow?.updatedAt?.let { runCatching { sqlTime.parse(it.take(19))?.time }.getOrNull() } ?: 0L
        val (pos, watched) = if (local != null && local.at >= serverAt) {
            local.position to (local.watched ?: false)
        } else {
            (serverRow?.position ?: 0.0) to (serverRow?.watched ?: false)
        }
        return if (watched || pos < 30) 0.0 else pos
    }

    @Synchronized
    fun knownFor(kind: String, id: Int): ProgressRow? = known()["$kind:$id"]

    /** Upload what's waiting and refresh the local copy. Quietly does nothing offline. */
    suspend fun sync(): Boolean = mutex.withLock {
        if (Prefs.token == null || Prefs.server.isEmpty()) return false
        val toSend = synchronized(this) { pending() }
        val rows = runCatching { Api.syncProgress(toSend.values.toList()) }.getOrElse { return false }
        synchronized(this) {
            val now = pending()
            // Drop only what was sent; anything recorded meanwhile stays queued.
            for ((k, v) in toSend) if (now[k]?.at == v.at) now.remove(k)
            savePending(now)
            saveKnown(rows.associateBy { "${it.kind}:${it.id}" })
        }
        return true
    }
}
