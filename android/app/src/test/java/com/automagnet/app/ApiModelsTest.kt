package com.automagnet.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The app's models against responses captured from a real server
 * (test/resources/api), so a field renamed on one side fails here rather than
 * as a blank screen on a phone.
 */
class ApiModelsTest {
    private fun res(name: String) = javaClass.classLoader!!.getResource("api/$name")!!.readText()

    @Test fun login() {
        val r = Api.json.decodeFromString<LoginResponse>(res("login.json"))
        assertEquals("admin", r.user.username)
        assertEquals("test-token", r.token)
    }

    @Test fun home() {
        val h = Api.json.decodeFromString<Home>(res("home.json"))
        assertEquals(1, h.cont.size)
        assertEquals(120.0, h.cont[0].progress!!.position, 0.0)
        assertTrue(h.recent.isNotEmpty())
    }

    @Test fun listings() {
        val movies = Api.json.decodeFromString<List<Item>>(res("movies.json"))
        assertTrue(movies.any { it.title == "Remux Film" && it.year == 2021 })
        val shows = Api.json.decodeFromString<List<ShowSummary>>(res("shows.json"))
        assertEquals(1, shows[0].unwatched)
        val show = Api.json.decodeFromString<ShowDetail>(res("show.json"))
        val eps = show.seasons.single().episodes
        assertEquals("S01E01", eps.first().code)
        assertTrue(eps.any { it.status == "upcoming" })
    }

    @Test fun directPlayItem() {
        val d = Api.json.decodeFromString<ItemDetail>(res("item-direct.json"))
        assertEquals("file", d.playback.mode)
        assertEquals("file", d.playback.download!!.type)
        assertNotNull(d.playback.download!!.size)
    }

    @Test fun hlsItemWithEmbeddedSubtitle() {
        val d = Api.json.decodeFromString<ItemDetail>(res("item-hls.json"))
        assertEquals("hls", d.playback.mode)
        assertEquals(true, d.playback.complete)
        assertEquals("hls", d.playback.download!!.type)
        val sub = d.subtitles.single()
        assertEquals("en", sub.lang)
        assertTrue(sub.url!!.endsWith(".vtt"))
    }

    @Test fun episodeWithNextAndSidecarSubtitle() {
        val d = Api.json.decodeFromString<ItemDetail>(res("item-episode.json"))
        assertEquals("Hevc Show", d.asItem().heading)
        assertEquals("S01E02", d.next!!.code)
        assertTrue(d.subtitles.isEmpty() || d.subtitles.all { it.url != null || !it.available })
        assertTrue(d.progress!!.watched)
    }

    @Test fun progressSync() {
        val rows = Api.json.decodeFromString<List<ProgressRow>>(res("sync.json"))
        assertTrue(rows.any { it.kind == "episode" && it.watched })
        assertNull(rows.first { it.kind == "episode" }.duration)
    }

    @Test fun downloadMetaRoundTrip() {
        val item = Api.json.decodeFromString<ItemDetail>(res("item-episode.json")).asItem()
        val meta = DownloadMeta(item, "hls", listOf(LocalSubtitle("f1", "English", "en", "/x.vtt", true)))
        val back = Api.json.decodeFromString<DownloadMeta>(Api.json.encodeToString(DownloadMeta.serializer(), meta))
        assertEquals(meta, back)
    }
}
