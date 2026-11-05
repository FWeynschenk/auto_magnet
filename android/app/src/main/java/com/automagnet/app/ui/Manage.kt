@file:kotlin.OptIn(
    androidx.compose.material3.ExperimentalMaterial3Api::class,
    androidx.compose.foundation.layout.ExperimentalLayoutApi::class,
)

package com.automagnet.app.ui

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.automagnet.app.AdminEpisode
import com.automagnet.app.AdminMovie
import com.automagnet.app.AdminShow
import com.automagnet.app.Api
import com.automagnet.app.ApiException
import com.automagnet.app.AuthException
import com.automagnet.app.Candidate
import com.automagnet.app.PickFor
import com.automagnet.app.PreviewResponse
import com.automagnet.app.TmdbResult
import com.automagnet.app.TxTarget
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The downloader side of the app, for admins: what is tracked, adding more,
// and picking releases. Everything here goes through the same endpoints as
// the web dashboard, so the two never disagree.

private val QUALITIES = listOf("2160p", "1080p", "720p")

/** Status in words, with its colour. */
private fun statusLine(status: String, progress: Int?): Pair<String, Color> = when (status) {
    "done" -> "Downloaded" to Green
    "downloading" -> "Downloading ${progress ?: 0}%" to Accent
    "pending" -> "Searching" to Muted
    "upcoming" -> "Not out yet" to Muted
    "failed" -> "Failed" to Red
    "skipped" -> "Skipped" to Muted
    else -> status to Muted
}

/** Run an action, toast its failure (or success), then refresh. */
private fun act(ctx: android.content.Context, scope: kotlinx.coroutines.CoroutineScope, done: String?, after: () -> Unit, block: suspend () -> Unit) {
    scope.launch {
        runCatching { block() }
            .onSuccess { if (done != null) Toast.makeText(ctx, done, Toast.LENGTH_SHORT).show() }
            .onFailure { Toast.makeText(ctx, it.message ?: "Failed", Toast.LENGTH_LONG).show() }
        after()
    }
}

@Composable
private fun Chips(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (value, label) -> FilterChip(selected == value, { onSelect(value) }, label = { Text(label) }) }
    }
}

@Composable
private fun Labeled(label: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = Muted, fontSize = 12.sp)
        content()
    }
}

@Composable
private fun BackBar(title: String, back: () -> Unit, actions: @Composable () -> Unit = {}) {
    TopAppBar(
        title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        navigationIcon = { IconButton(onClick = back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        actions = { actions() },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Bg),
    )
}

@Composable
private fun ConfirmDialog(text: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        text = { Text(text) },
        confirmButton = { TextButton(onClick = { onDismiss(); onConfirm() }) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// ─── The Manage tab ───────────────────────────────────────────────────────────

private class Tracked(val movies: List<AdminMovie>, val shows: List<AdminShow>)

@Composable
fun ManageTab(
    refresh: Int,
    openMovie: (Int) -> Unit,
    openShow: (Int) -> Unit,
    openAdd: () -> Unit,
    openPick: (PickFor) -> Unit,
    onAuth: () -> Unit,
) {
    val (s, retry) = rememberLoad(refresh, onAuth) {
        coroutineScope {
            val m = async { Api.trackedMovies() }
            val sh = async { Api.trackedShows() }
            Tracked(m.await(), sh.await())
        }
    }
    var showsTab by rememberSaveable { mutableStateOf(false) }
    val data = s.value

    Box(Modifier.fillMaxSize()) {
        when {
            data == null && s.loading -> Centered("Loading…")
            data == null -> Centered(s.error ?: "Error") { OutlinedButton(onClick = retry) { Text("Retry") } }
            else -> LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 88.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)) {
                // Manual mode: the scheduler found releases and waits for a pick.
                val waitingMovies = data.movies.filter { it.needsChoice }
                val waitingShows = data.shows.mapNotNull { sh -> sh.waitingOn?.let { sh to it } }
                if (waitingMovies.isNotEmpty() || waitingShows.isNotEmpty()) {
                    item { Text("Waiting for you", color = Muted, fontWeight = FontWeight.SemiBold, fontSize = 14.sp) }
                    items(waitingMovies, key = { "wm${it.id}" }) { m ->
                        WaitingRow(m.title, m.year?.toString() ?: "Movie", m.posterUrl) {
                            openPick(PickFor("movie", m.tmdbId, m.id, m.title, m.quality))
                        }
                    }
                    items(waitingShows, key = { "ws${it.first.id}" }) { (sh, ep) ->
                        WaitingRow(sh.title, ep.code, sh.posterUrl) {
                            openPick(PickFor("show", sh.tmdbId, sh.id, sh.title, sh.quality, ep.season, ep.episode, ep.id))
                        }
                    }
                    item { Spacer(Modifier.height(4.dp)) }
                }
                item {
                    Chips(listOf("m" to "Movies (${data.movies.size})", "s" to "Shows (${data.shows.size})"),
                        if (showsTab) "s" else "m") { showsTab = it == "s" }
                }
                if (!showsTab) {
                    if (data.movies.isEmpty()) item { Text("No movies yet — add one with +.", color = Muted) }
                    items(data.movies, key = { "m${it.id}" }) { m ->
                        val (line, color) = statusLine(m.status, m.progress)
                        TrackedRow(m.title, listOfNotNull(m.year?.toString(), m.quality, if (m.mode == "manual") "manual" else null).joinToString(" · "),
                            line, color, m.lastError, m.posterUrl, if (m.status == "downloading") (m.progress ?: 0) / 100f else null) { openMovie(m.id) }
                    }
                } else {
                    if (data.shows.isEmpty()) item { Text("No shows yet — add one with +.", color = Muted) }
                    items(data.shows, key = { "s${it.id}" }) { sh ->
                        val parts = listOfNotNull(
                            "${sh.count("done")} downloaded",
                            sh.count("downloading").takeIf { it > 0 }?.let { "$it downloading" },
                            sh.count("pending").takeIf { it > 0 }?.let { "$it searching" },
                            sh.count("failed").takeIf { it > 0 }?.let { "$it failed" },
                        )
                        TrackedRow(sh.title, listOfNotNull(sh.quality, if (sh.mode == "manual") "manual" else null, if (sh.active == 0) "paused" else null).joinToString(" · "),
                            parts.joinToString(" · "), if (sh.count("failed") > 0) Red else Muted, null, sh.posterUrl, null) { openShow(sh.id) }
                    }
                }
            }
        }
        FloatingActionButton(onClick = openAdd, containerColor = Accent, modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp)) {
            Icon(Icons.Default.Add, "Add a movie or show")
        }
    }
}

@Composable
private fun WaitingRow(title: String, sub: String, poster: String?, onChoose: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(Surface, RoundedCornerShape(10.dp)).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Artwork(poster, title, false, 0f, false, modifier = Modifier.width(40.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(sub, color = Muted, fontSize = 12.sp)
        }
        Button(onClick = onChoose) { Text("Choose") }
    }
}

@Composable
private fun TrackedRow(title: String, sub: String, status: String, statusColor: Color, error: String?, poster: String?, progress: Float?, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Artwork(poster, title, false, 0f, false, modifier = Modifier.width(48.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sub.isNotEmpty()) Text(sub, color = Muted, fontSize = 12.sp)
            Text(status, color = statusColor, fontSize = 12.sp)
            if (progress != null) LinearProgressIndicator(progress = { progress.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
            error?.let { Text("⚠ $it", color = Red, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
    }
}

// ─── Adding ───────────────────────────────────────────────────────────────────

@Composable
fun AddScreen(back: () -> Unit, added: (type: String, id: Int) -> Unit, onAuth: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<TmdbResult>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var picked by remember { mutableStateOf<TmdbResult?>(null) }
    var targets by remember { mutableStateOf<List<TxTarget>>(emptyList()) }

    LaunchedEffect(Unit) { targets = runCatching { Api.targets() }.getOrDefault(emptyList()) }
    // Type-ahead, like the web dialog: search once typing pauses.
    LaunchedEffect(query) {
        if (query.trim().length < 2) { results = emptyList(); return@LaunchedEffect }
        delay(400)
        searching = true; error = null
        try { results = Api.searchTmdb(query.trim()) }
        catch (e: AuthException) { onAuth() }
        catch (e: Exception) { error = e.message }
        finally { searching = false }
    }

    val p = picked
    Scaffold(topBar = { BackBar(if (p == null) "Add a movie or show" else p.title, { if (p != null) picked = null else back() }) }) { pad ->
        Box(Modifier.padding(pad)) {
            if (p != null) {
                AddOptions(p, targets, added, onAuth)
                return@Box
            }
            Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
                OutlinedTextField(query, { query = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("Search TMDB") }, leadingIcon = { Icon(Icons.Default.Search, null) },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search))
                when {
                    searching && results.isEmpty() -> Centered("Searching…")
                    error != null -> Centered(error!!)
                    query.trim().length >= 2 && results.isEmpty() && !searching -> Centered("Nothing found on TMDB.")
                    else -> LazyColumn(contentPadding = PaddingValues(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(results, key = { "${it.type}${it.tmdbId}" }) { r ->
                            Row(Modifier.fillMaxWidth().clickable { picked = r }, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Artwork(r.posterUrl, r.title, false, 0f, false, modifier = Modifier.width(56.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(r.title, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    Text(listOfNotNull(if (r.type == "tv") "Show" else "Movie", r.year?.ifEmpty { null }).joinToString(" · "), color = Muted, fontSize = 12.sp)
                                    r.overview?.let { Text(it, color = Muted, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AddOptions(r: TmdbResult, targets: List<TxTarget>, added: (String, Int) -> Unit, onAuth: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val isShow = r.type == "tv"
    var quality by rememberSaveable { mutableStateOf("1080p") }
    var mode by rememberSaveable { mutableStateOf("auto") }
    var season by rememberSaveable { mutableStateOf("1") }
    var episode by rememberSaveable { mutableStateOf("1") }
    var packs by rememberSaveable { mutableStateOf(false) }
    var target by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Artwork(r.posterUrl, r.title, false, 0f, false, modifier = Modifier.width(100.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(r.title, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Text(listOfNotNull(if (isShow) "Show" else "Movie", r.year?.ifEmpty { null }).joinToString(" · "), color = Muted)
                r.overview?.let { Text(it, color = Muted, fontSize = 12.sp, maxLines = 6, overflow = TextOverflow.Ellipsis) }
            }
        }
        Labeled("Quality") { Chips(QUALITIES.map { it to it }, quality) { quality = it } }
        Labeled("Mode") {
            Chips(listOf("auto" to "Automatic", "manual" to "I'll choose"), mode) { mode = it }
        }
        Text(if (mode == "auto") "The best release is grabbed as soon as there is one." else
            "Releases are found for you; nothing downloads until you choose one under Manage → Waiting for you.", color = Muted, fontSize = 12.sp)
        if (isShow) {
            Labeled("Start from") {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(season, { season = it.filter(Char::isDigit).take(3) }, label = { Text("Season") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
                    OutlinedTextField(episode, { episode = it.filter(Char::isDigit).take(4) }, label = { Text("Episode") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Prefer season packs")
                    Text("Grab whole seasons where every episode is still missing", color = Muted, fontSize = 12.sp)
                }
                Switch(packs, { packs = it })
            }
        }
        if (targets.size > 1) {
            Labeled("Download to") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    targets.forEachIndexed { i, t ->
                        // The first is the default instance; "" sends nothing, as the web dialog does.
                        val value = if (i == 0) "" else t.name
                        FilterChip(target == value, { target = value }, label = { Text(t.name) })
                    }
                }
            }
        }
        Button(
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
            onClick = {
                busy = true
                scope.launch {
                    try {
                        val t = target.ifEmpty { null }
                        if (isShow) {
                            val sh = Api.addShow(r.tmdbId, quality, mode, season.toIntOrNull() ?: 1, episode.toIntOrNull() ?: 1, packs, t)
                            Toast.makeText(ctx, "Added ${sh.title}", Toast.LENGTH_SHORT).show()
                            added("show", sh.id)
                        } else {
                            val m = Api.addMovie(r.tmdbId, quality, mode, t)
                            Toast.makeText(ctx, "Added ${m.title}", Toast.LENGTH_SHORT).show()
                            added("movie", m.id)
                        }
                    } catch (e: AuthException) { onAuth() }
                    catch (e: Exception) { Toast.makeText(ctx, e.message ?: "Couldn't add it", Toast.LENGTH_LONG).show() }
                    finally { busy = false }
                }
            },
        ) { Text(if (busy) "Adding…" else "Add ${if (isShow) "show" else "movie"}") }
    }
}

// ─── One movie ────────────────────────────────────────────────────────────────

@Composable
fun ManageMovieScreen(id: Int, back: () -> Unit, openPick: (PickFor) -> Unit, onAuth: () -> Unit) {
    var refresh by remember { mutableIntStateOf(0) }
    val (s, retry) = rememberLoad(id to refresh, onAuth) { Api.trackedMovies().firstOrNull { it.id == id } }
    val m = s.value
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var confirmDelete by remember { mutableStateOf(false) }
    // Downloads move on their own; keep the numbers current.
    LaunchedEffect(id) { while (true) { delay(10_000); refresh++ } }

    Scaffold(topBar = {
        BackBar(m?.title ?: "", back) {
            IconButton(onClick = { refresh++ }) { Icon(Icons.Default.Refresh, "Refresh") }
            if (m != null) IconButton(onClick = { confirmDelete = true }) { Icon(Icons.Default.Delete, "Remove") }
        }
    }) { pad ->
        Box(Modifier.padding(pad)) {
            if (m == null) {
                if (s.loading) Centered("Loading…") else Centered(s.error ?: "This movie isn't tracked any more") { OutlinedButton(onClick = retry) { Text("Retry") } }
                return@Box
            }
            val after: () -> Unit = { refresh++ }
            Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Artwork(m.posterUrl, m.title, false, 0f, false, modifier = Modifier.width(100.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(m.title, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        m.year?.let { Text(it.toString(), color = Muted) }
                        val (line, color) = statusLine(m.status, m.progress)
                        Text(line, color = color)
                        if (m.status == "downloading") LinearProgressIndicator(progress = { (m.progress ?: 0) / 100f }, modifier = Modifier.fillMaxWidth())
                        m.releaseDate?.let { Text("Digital release $it", color = Muted, fontSize = 12.sp) }
                    }
                }
                m.lastError?.let { Text("⚠ $it", color = Red, fontSize = 13.sp) }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(onClick = { openPick(PickFor("movie", m.tmdbId, m.id, m.title, m.quality)) }) {
                        Text(if (m.needsChoice) "Choose a release" else "Choose…")
                    }
                    if (m.status in setOf("done", "downloading", "failed") || (m.mode == "auto" && m.status == "pending")) {
                        OutlinedButton(onClick = { act(ctx, scope, "Searching again", after) { Api.redoMovie(m.id) } }) { Text("Redo") }
                    }
                }
                Labeled("Quality") { Chips(QUALITIES.map { it to it }, m.quality) { q -> act(ctx, scope, null, after) { Api.updateMovie(m.id, "quality" to q) } } }
                Labeled("Mode") {
                    Chips(listOf("auto" to "Automatic", "manual" to "I'll choose"), m.mode) { md -> act(ctx, scope, null, after) { Api.updateMovie(m.id, "mode" to md) } }
                }
            }
        }
    }
    if (confirmDelete && m != null) {
        ConfirmDialog("Stop tracking ${m.title}? Files already downloaded stay where they are.", "Remove",
            onConfirm = { act(ctx, scope, "Removed", back) { Api.deleteMovie(m.id) } }, onDismiss = { confirmDelete = false })
    }
}

// ─── One show ─────────────────────────────────────────────────────────────────

@Composable
fun ManageShowScreen(id: Int, back: () -> Unit, openPick: (PickFor) -> Unit, onAuth: () -> Unit) {
    var refresh by remember { mutableIntStateOf(0) }
    val (s, retry) = rememberLoad(id to refresh, onAuth) { Api.trackedShows().firstOrNull { it.id == id } }
    val sh = s.value
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var confirmDelete by remember { mutableStateOf(false) }
    var season by rememberSaveable { mutableStateOf<Int?>(null) }
    LaunchedEffect(id) { while (true) { delay(15_000); refresh++ } }

    Scaffold(topBar = {
        BackBar(sh?.title ?: "", back) {
            IconButton(onClick = { refresh++ }) { Icon(Icons.Default.Refresh, "Refresh") }
            if (sh != null) IconButton(onClick = { confirmDelete = true }) { Icon(Icons.Default.Delete, "Remove") }
        }
    }) { pad ->
        Box(Modifier.padding(pad)) {
            if (sh == null) {
                if (s.loading) Centered("Loading…") else Centered(s.error ?: "This show isn't tracked any more") { OutlinedButton(onClick = retry) { Text("Retry") } }
                return@Box
            }
            val after: () -> Unit = { refresh++ }
            val seasons = sh.episodes.groupBy { it.season }.toSortedMap()
            // Open on the first season with something still to do.
            val current = season?.takeIf { it in seasons }
                ?: seasons.entries.firstOrNull { (_, eps) -> eps.any { it.status != "done" && it.status != "skipped" } }?.key
                ?: seasons.keys.lastOrNull()
            LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                item {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            Artwork(sh.posterUrl, sh.title, false, 0f, false, modifier = Modifier.width(90.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(sh.title, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                                sh.showStatus?.let { Text(it, color = Muted, fontSize = 12.sp) }
                                Text(listOf("done" to "downloaded", "downloading" to "downloading", "pending" to "searching",
                                    "upcoming" to "upcoming", "failed" to "failed")
                                    .mapNotNull { (st, w) -> sh.count(st).takeIf { it > 0 }?.let { "$it $w" } }.joinToString(" · "),
                                    color = Muted, fontSize = 12.sp)
                            }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Follow new episodes", Modifier.weight(1f))
                            Switch(sh.active != 0, { on -> act(ctx, scope, null, after) { Api.updateShow(sh.id, "active" to (if (on) 1 else 0)) } })
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Prefer season packs", Modifier.weight(1f))
                            Switch((sh.preferPack ?: 0) != 0, { on -> act(ctx, scope, null, after) { Api.updateShow(sh.id, "prefer_season_pack" to (if (on) 1 else 0)) } })
                        }
                        Labeled("Quality") { Chips(QUALITIES.map { it to it }, sh.quality) { q -> act(ctx, scope, null, after) { Api.updateShow(sh.id, "quality" to q) } } }
                        Labeled("Mode") {
                            Chips(listOf("auto" to "Automatic", "manual" to "I'll choose"), sh.mode) { md -> act(ctx, scope, null, after) { Api.updateShow(sh.id, "mode" to md) } }
                        }
                        OutlinedButton(onClick = { act(ctx, scope, "Episode list refreshed from TMDB", after) { Api.refreshTmdb(sh.id) } }) {
                            Text("Refresh episodes from TMDB")
                        }
                    }
                }
                if (seasons.size > 1) item {
                    ScrollableTabRow(selectedTabIndex = seasons.keys.indexOf(current).coerceAtLeast(0), containerColor = Bg, edgePadding = 8.dp) {
                        seasons.keys.forEach { n -> Tab(n == current, { season = n }, text = { Text("Season $n") }) }
                    }
                }
                items(seasons[current] ?: emptyList(), key = { it.id }) { ep ->
                    EpisodeRow(ep,
                        choose = { openPick(PickFor("show", sh.tmdbId, sh.id, sh.title, sh.quality, ep.season, ep.episode, ep.id)) },
                        redo = { act(ctx, scope, null, after) { Api.redoEpisode(sh.id, ep.id) } },
                        skip = { act(ctx, scope, null, after) { Api.skipEpisode(sh.id, ep.id) } })
                }
            }
        }
    }
    if (confirmDelete && sh != null) {
        ConfirmDialog("Stop tracking ${sh.title}? Files already downloaded stay where they are.", "Remove",
            onConfirm = { act(ctx, scope, "Removed", back) { Api.deleteShow(sh.id) } }, onDismiss = { confirmDelete = false })
    }
}

@Composable
private fun EpisodeRow(ep: AdminEpisode, choose: () -> Unit, redo: () -> Unit, skip: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Episode ${ep.episode}", fontWeight = FontWeight.SemiBold)
                val (line, color) = statusLine(ep.status, ep.progress)
                Text(listOfNotNull(line, ep.airDate?.let { "aired $it" }?.takeIf { ep.status != "upcoming" }, ep.airDate?.takeIf { ep.status == "upcoming" }?.let { "airs $it" })
                    .joinToString(" · "), color = color, fontSize = 12.sp)
            }
            // The same actions, on the same statuses, as the web dashboard.
            if (ep.status != "upcoming") TextButton(onClick = choose) { Text("Choose") }
            if (ep.status == "skipped") TextButton(onClick = redo) { Text("Restore") }
            else if (ep.status != "upcoming") TextButton(onClick = redo) { Text("Redo") }
            if (ep.status == "pending" || ep.status == "failed") TextButton(onClick = skip) { Text("Skip", color = Muted) }
        }
        if (ep.status == "downloading") LinearProgressIndicator(progress = { (ep.progress ?: 0) / 100f }, modifier = Modifier.fillMaxWidth())
        ep.lastError?.let { Text("⚠ $it", color = Red, fontSize = 11.sp, maxLines = 3, overflow = TextOverflow.Ellipsis) }
    }
}

// ─── Choosing a release ──────────────────────────────────────────────────────

@Composable
fun PickScreen(pick: PickFor, back: () -> Unit, onAuth: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<PreviewResponse?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var queryInput by rememberSaveable { mutableStateOf("") }
    var activeQuery by rememberSaveable { mutableStateOf("") }
    var load by remember { mutableIntStateOf(0) }
    var refresh by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<Candidate?>(null) }
    var grabbing by remember { mutableStateOf(false) }
    var showRejected by remember { mutableStateOf(false) }

    LaunchedEffect(load) {
        loading = true; error = null
        try { data = Api.preview(pick, refresh, activeQuery) }
        catch (e: AuthException) { onAuth() }
        catch (e: Exception) { error = e.message ?: "The search failed" }
        finally { loading = false; refresh = false }
    }

    val subtitle = if (pick.season != null && pick.episode != null) " · S%02dE%02d".format(pick.season, pick.episode) else ""
    Scaffold(topBar = {
        BackBar("${pick.title}$subtitle", back) {
            IconButton(enabled = !loading, onClick = { refresh = true; load++ }) { Icon(Icons.Default.Refresh, "Search again") }
        }
    }) { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                OutlinedTextField(queryInput, { queryInput = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("Search the indexers for something else") },
                    leadingIcon = { Icon(Icons.Default.Search, null) },
                    trailingIcon = if (activeQuery.isNotEmpty()) ({
                        TextButton(onClick = { queryInput = ""; activeQuery = ""; load++ }) { Text("Clear") }
                    }) else null,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { activeQuery = queryInput.trim(); load++ }))
            }
            val d = data
            when {
                loading -> item { Centered("Asking every indexer — this can take up to a minute. The result is reused afterwards.", Modifier.height(240.dp)) }
                error != null -> item { Centered(error!!, Modifier.height(200.dp)) { OutlinedButton(onClick = { load++ }) { Text("Retry") } } }
                d != null -> {
                    item {
                        Text(
                            when {
                                d.query != null -> "Custom search: “${d.query}”"
                                d.cached -> "From the last search${d.cacheAgeMs?.let { " ${it / 60_000} min ago" } ?: ""} — ↻ to search again"
                                else -> "Fresh from the indexers"
                            }, color = Muted, fontSize = 12.sp,
                        )
                    }
                    if (d.results.isEmpty()) item {
                        Text(if (d.rejected.isNotEmpty()) "Nothing usable came back — ${d.rejected.size} filtered out, see below."
                            else "Nothing usable came back. Try a custom search, or ↻.", color = Muted)
                    }
                    items(d.results, key = { it.magnet ?: it.title }) { c -> CandidateCard(c, enabled = !grabbing) { confirm = c } }
                    if (d.rejected.isNotEmpty()) {
                        item {
                            TextButton(onClick = { showRejected = !showRejected }) {
                                Text("${if (showRejected) "▾" else "▸"} ${d.rejected.size} filtered out", color = Muted)
                            }
                        }
                        if (showRejected) items(d.rejected) { r ->
                            Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
                                Text(r.title, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(r.reason ?: "", color = Muted, fontSize = 11.sp)
                            }
                        }
                    }
                }
            }
        }
    }

    confirm?.let { c ->
        ConfirmDialog("Download this release?\n\n${c.title}\n${c.quality ?: ""} · ${fmtSize(c.size)} · ${c.seeders} seeders", "Download",
            onConfirm = {
                grabbing = true
                scope.launch {
                    try {
                        val r = Api.grab(pick, c)
                        Toast.makeText(ctx, when {
                            r.duplicate -> "Already in Transmission — tracking it"
                            r.quarantined -> "Sent — held until its file list is checked"
                            else -> "Sent to Transmission"
                        }, Toast.LENGTH_LONG).show()
                        back()
                    } catch (e: AuthException) { onAuth() }
                    catch (e: ApiException) {
                        // 422: the content screen rejected it.
                        Toast.makeText(ctx, e.message, Toast.LENGTH_LONG).show()
                    } catch (e: Exception) { Toast.makeText(ctx, e.message ?: "Couldn't grab it", Toast.LENGTH_LONG).show() }
                    finally { grabbing = false }
                }
            },
            onDismiss = { confirm = null })
    }
}

@Composable
private fun CandidateCard(c: Candidate, enabled: Boolean, onGrab: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(Surface, RoundedCornerShape(10.dp)).clickable(enabled = enabled, onClick = onGrab).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(c.title, fontSize = 13.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Tag(c.quality ?: "?", Accent)
            Tag("${c.seeders} seeds", if (c.seeders >= 10) Green else Muted)
            Tag(fmtSize(c.size), Muted)
            Tag(c.indexer ?: c.source ?: "?", Muted)
            if ((c.mirrors ?: 1) > 1) Tag("×${c.mirrors}", Muted)
            if (c.fileCount > 0) Tag("✓ contents checked", Green)
            c.warnings.forEach { Tag("⚠ $it", Red) }
        }
    }
}

@Composable
private fun Tag(text: String, color: Color) {
    Text(text, color = color, fontSize = 11.sp,
        modifier = Modifier.background(color.copy(alpha = 0.15f), RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
}
