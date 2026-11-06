@file:androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
@file:kotlin.OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.automagnet.app.ui

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.offline.Download
import com.automagnet.app.Api
import com.automagnet.app.AuthException
import com.automagnet.app.Downloads
import com.automagnet.app.Home
import com.automagnet.app.Item
import com.automagnet.app.ItemDetail
import com.automagnet.app.PlayerActivity
import com.automagnet.app.Prefs
import com.automagnet.app.ProgressStore
import com.automagnet.app.R
import com.automagnet.app.ShowDetail
import com.automagnet.app.ShowSummary
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Load something from the API, with loading/error state and a retry. */
class Loaded<T>(val value: T?, val error: String?, val loading: Boolean)

@Composable
fun <T> rememberLoad(key: Any?, onAuth: () -> Unit, fetch: suspend () -> T): Pair<Loaded<T>, () -> Unit> {
    var state by remember(key) { mutableStateOf(Loaded<T>(null, null, true)) }
    var tick by remember(key) { mutableIntStateOf(0) }
    LaunchedEffect(key, tick) {
        state = Loaded(state.value, null, true)
        state = try {
            Loaded(fetch(), null, false)
        } catch (e: AuthException) {
            onAuth(); Loaded(null, e.message, false)
        } catch (e: Exception) {
            Loaded(state.value, e.message ?: "Couldn't reach the server", false)
        }
    }
    return state to { tick++ }
}

// ─── Sign in ───────────────────────────────────────────────────────────────────

@Composable
fun LoginScreen(onDone: () -> Unit) {
    var server by rememberSaveable { mutableStateOf(Prefs.server.ifEmpty { "http://" }) }
    var user by rememberSaveable { mutableStateOf(Prefs.username ?: "") }
    var pass by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically),
    ) {
        Text("⚡ auto_magnet", color = Accent, fontWeight = FontWeight.Bold, fontSize = 22.sp)
        Text("Sign in to your server", color = Muted)
        OutlinedTextField(server, { server = it }, label = { Text("Server address") }, singleLine = true,
            placeholder = { Text("http://192.168.0.102:62201") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth())
        OutlinedTextField(user, { user = it }, label = { Text("Username") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(pass, { pass = it }, label = { Text("Password") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth())
        error?.let { Text(it, color = Red, fontSize = 13.sp) }
        Button(
            onClick = {
                busy = true; error = null
                scope.launch {
                    try {
                        Api.login(server.trim().trimEnd('/'), user.trim(), pass)
                        ProgressStore.sync()
                        onDone()
                    } catch (e: Exception) {
                        error = e.message ?: "Couldn't reach the server"
                    } finally { busy = false }
                }
            },
            enabled = !busy && server.length > 8 && user.isNotBlank() && pass.isNotEmpty(),
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "Signing in…" else "Sign in") }
    }
}

// ─── Main tabs ────────────────────────────────────────────────────────────────

/** Where the Manage tab's pieces open. */
class ManageNav(
    val movie: (Int) -> Unit,
    val show: (Int) -> Unit,
    val add: () -> Unit,
    val pick: (com.automagnet.app.PickFor) -> Unit,
)

@Composable
fun MainScreen(openItem: (Item) -> Unit, openShow: (Int) -> Unit, manage: ManageNav, onSignOut: () -> Unit, onAuth: () -> Unit) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var menu by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val titles = listOf("Home", "Movies", "Shows", "Downloads", "Manage")
    // Admins also run the downloader. Sessions from before this was stored
    // learn their role here; offline, the last known one stands.
    var admin by remember { mutableStateOf(Prefs.isAdmin) }
    LaunchedEffect(Unit) { runCatching { Api.me() }; admin = Prefs.isAdmin; if (!admin && tab == 4) tab = 0 }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(titles[tab]) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Bg),
                actions = {
                    IconButton(onClick = { refresh++ }) { Icon(Icons.Default.Refresh, "Refresh") }
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "Menu") }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text("${Prefs.username} @ ${Prefs.server.removePrefix("http://").removePrefix("https://")}", color = Muted) }, onClick = {}, enabled = false)
                        DropdownMenuItem(text = { Text("Sign out") }, onClick = {
                            menu = false
                            scope.launch { ProgressStore.sync(); Api.logout(); onSignOut() }
                        })
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar(containerColor = Surface) {
                NavigationBarItem(tab == 0, { tab = 0 }, { Icon(Icons.Default.Home, null) }, label = { Text("Home") })
                NavigationBarItem(tab == 1, { tab = 1 }, { Icon(Icons.Default.Star, null) }, label = { Text("Movies") })
                NavigationBarItem(tab == 2, { tab = 2 }, { Icon(Icons.AutoMirrored.Filled.List, null) }, label = { Text("Shows") })
                // Five tabs leave too little width for "Downloads" on one line at the default size.
                NavigationBarItem(tab == 3, { tab = 3 }, { Icon(painterResource(R.drawable.ic_download), null) },
                    label = { Text("Downloads", maxLines = 1, softWrap = false, fontSize = if (admin) 11.sp else 12.sp) })
                if (admin) NavigationBarItem(tab == 4, { tab = 4 }, { Icon(Icons.Default.Build, null) }, label = { Text("Manage") })
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad)) {
            when (tab) {
                0 -> HomeTab(refresh, openItem, onAuth) { tab = 3 }
                1 -> MoviesTab(refresh, openItem, onAuth)
                2 -> ShowsTab(refresh, openShow, onAuth)
                4 -> ManageTab(refresh, manage.movie, manage.show, manage.add, manage.pick, onAuth)
                else -> DownloadsTab(openItem)
            }
        }
    }
}

@Composable
fun HomeTab(refresh: Int, openItem: (Item) -> Unit, onAuth: () -> Unit, goDownloads: () -> Unit) {
    val (s, retry) = rememberLoad(refresh, onAuth) { ProgressStore.sync(); Api.home() }
    val home: Home? = s.value
    when {
        home == null && s.loading -> Centered("Loading…")
        home == null -> Centered("Offline: ${s.error}") {
            OutlinedButton(onClick = retry) { Text("Retry") }
            Spacer(Modifier.width(8.dp))
            Button(onClick = goDownloads) { Text("Downloads") }
        }
        home.cont.isEmpty() && home.nextUp.isEmpty() && home.recent.isEmpty() -> Centered("Nothing has finished downloading yet.")
        else -> LazyColumn(contentPadding = PaddingValues(bottom = 16.dp)) {
            item { ItemRow("Continue watching", home.cont, true, openItem) }
            item { ItemRow("Next up", home.nextUp, true, openItem) }
            item { ItemRow("Recently added", home.recent, false, openItem) }
        }
    }
}

@Composable
fun MoviesTab(refresh: Int, openItem: (Item) -> Unit, onAuth: () -> Unit) {
    val (s, retry) = rememberLoad(refresh, onAuth) { Api.movies() }
    val list = s.value
    when {
        list == null && s.loading -> Centered("Loading…")
        list == null -> Centered(s.error ?: "Error") { OutlinedButton(onClick = retry) { Text("Retry") } }
        list.isEmpty() -> Centered("No movies yet.")
        else -> LazyVerticalGrid(GridCells.Adaptive(110.dp), contentPadding = PaddingValues(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            items(list, key = { it.key }) { ItemCard(it, false, 110.dp) { openItem(it) } }
        }
    }
}

@Composable
fun ShowsTab(refresh: Int, openShow: (Int) -> Unit, onAuth: () -> Unit) {
    val (s, retry) = rememberLoad(refresh, onAuth) { Api.shows() }
    val list: List<ShowSummary>? = s.value
    when {
        list == null && s.loading -> Centered("Loading…")
        list == null -> Centered(s.error ?: "Error") { OutlinedButton(onClick = retry) { Text("Retry") } }
        list.isEmpty() -> Centered("No shows yet.")
        else -> LazyVerticalGrid(GridCells.Adaptive(110.dp), contentPadding = PaddingValues(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            items(list, key = { it.id }) { sh ->
                Column(Modifier.clickable { openShow(sh.id) }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Artwork(sh.posterUrl, sh.title, false, 0f, false, if (sh.unwatched > 0) sh.unwatched.toString() else null)
                    Text(sh.title, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(if (sh.unwatched > 0) "${sh.unwatched} unwatched" else "${sh.available} episodes", color = Muted, fontSize = 12.sp)
                }
            }
        }
    }
}

// ─── A show ───────────────────────────────────────────────────────────────────

@Composable
fun ShowScreen(id: Int, back: () -> Unit, openItem: (Item) -> Unit, onAuth: () -> Unit) {
    var refresh by remember { mutableIntStateOf(0) }
    val (s, retry) = rememberLoad(id to refresh, onAuth) { Api.show(id) }
    val data: ShowDetail? = s.value
    var season by rememberSaveable { mutableStateOf<Int?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current

    Scaffold(topBar = {
        TopAppBar(title = { Text(data?.show?.title ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { IconButton(onClick = back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = Bg))
    }) { pad ->
        Box(Modifier.padding(pad)) {
            when {
                data == null && s.loading -> Centered("Loading…")
                data == null -> Centered(s.error ?: "Error") { OutlinedButton(onClick = retry) { Text("Retry") } }
                else -> {
                    val seasons = data.seasons
                    val current = seasons.firstOrNull { it.season == season }
                        ?: seasons.firstOrNull { se -> se.episodes.any { it.status == "done" && it.progress?.watched != true } }
                        ?: seasons.firstOrNull()
                    Column {
                        if (seasons.size > 1) {
                            ScrollableTabRow(selectedTabIndex = seasons.indexOf(current).coerceAtLeast(0), containerColor = Bg, edgePadding = 8.dp) {
                                seasons.forEach { se -> Tab(se == current, { season = se.season }, text = { Text("Season ${se.season}") }) }
                            }
                        }
                        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            items(current?.episodes ?: emptyList(), key = { it.id }) { e ->
                                val playable = e.status == "done"
                                Row(
                                    Modifier.fillMaxWidth().clickable(enabled = playable) { openItem(e) },
                                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                                ) {
                                    Artwork(e.stillUrl, e.title, true, progressOf(e), e.progress?.watched == true, modifier = Modifier.width(130.dp))
                                    Column(Modifier.weight(1f)) {
                                        Text("${e.episode}. ${e.title}", fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                            color = if (playable) androidx.compose.ui.graphics.Color.White else Muted)
                                        Text(
                                            when (e.status) {
                                                "done" -> e.duration?.let { "${(it / 60).toInt()} min" } ?: ""
                                                "downloading" -> "Downloading on the server…"
                                                "upcoming" -> e.airDateText()
                                                else -> "Not available yet"
                                            }, color = Muted, fontSize = 12.sp,
                                        )
                                        if (playable) DownloadBadge(e.kind, e.id)
                                    }
                                    if (playable) {
                                        IconButton(onClick = {
                                            scope.launch {
                                                runCatching { Api.setWatched(e.kind, e.id, e.progress?.watched != true) }
                                                    .onFailure { Toast.makeText(ctx, it.message, Toast.LENGTH_SHORT).show() }
                                                refresh++
                                            }
                                        }) {
                                            Text(if (e.progress?.watched == true) "✓" else "○", color = if (e.progress?.watched == true) Green else Muted, fontSize = 20.sp)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun Item.airDateText() = airDate?.let { "Airs $it" } ?: "Upcoming"

/** A one-line download state for an item, updating while it changes. */
@Composable
fun DownloadBadge(kind: String, id: Int) {
    val d = rememberDownload(kind, id) ?: return
    val text = when (d.state) {
        Download.STATE_COMPLETED -> "✓ Downloaded"
        Download.STATE_DOWNLOADING -> "Downloading ${d.percentDownloaded.toInt().coerceAtLeast(0)}%"
        Download.STATE_QUEUED -> "Download queued"
        Download.STATE_FAILED -> "Download failed"
        Download.STATE_STOPPED -> "Download paused"
        else -> return
    }
    Text(text, color = if (d.state == Download.STATE_COMPLETED) Green else Accent, fontSize = 12.sp)
}

@Composable
fun rememberDownload(kind: String, id: Int): Download? {
    var d by remember(kind, id) { mutableStateOf(Downloads.get(kind, id)) }
    LaunchedEffect(kind, id) {
        while (true) {
            d = Downloads.get(kind, id)
            delay(if (d?.state == Download.STATE_DOWNLOADING || d?.state == Download.STATE_QUEUED) 1000 else 3000)
        }
    }
    return d
}

// ─── One movie or episode ────────────────────────────────────────────────────

@Composable
fun DetailScreen(kind: String, id: Int, back: () -> Unit, onAuth: () -> Unit) {
    var refresh by remember { mutableIntStateOf(0) }
    val download = rememberDownload(kind, id)
    val offline = download?.let { Downloads.meta(it) }
    val (s, retry) = rememberLoad(Triple(kind, id, refresh), onAuth) { Api.item(kind, id) }
    val detail: ItemDetail? = s.value
    val item: Item? = detail?.asItem() ?: offline?.item
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }

    // Coming back from the player: show the new resume point.
    LaunchedEffect(Unit) {
        while (true) { delay(15_000); if (detail != null) refresh++ }
    }

    Scaffold(topBar = {
        TopAppBar(title = { Text(item?.heading ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { IconButton(onClick = back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = Bg))
    }) { pad ->
        Box(Modifier.padding(pad)) {
            if (item == null) {
                if (s.loading) Centered("Loading…") else Centered(s.error ?: "Error") { OutlinedButton(onClick = retry) { Text("Retry") } }
                return@Box
            }
            Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                val wide = kind == "episode" && item.stillUrl != null
                Artwork(if (wide) item.stillUrl else item.posterUrl, item.heading, wide, progressOf(item), item.progress?.watched == true,
                    modifier = if (wide) Modifier.fillMaxWidth() else Modifier.width(180.dp))
                Text(item.heading, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text(listOfNotNull(item.subheading.ifEmpty { null }, item.duration?.let { "${(it / 60).toInt()} min" }).joinToString(" · "), color = Muted)

                val resume = ProgressStore.resumeFor(kind, id, item.progress)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Button(onClick = { PlayerActivity.start(ctx, kind, id) }) {
                        Icon(Icons.Default.PlayArrow, null); Spacer(Modifier.width(6.dp))
                        Text(if (resume > 0) "Resume ${fmtTime(resume)}" else "Play")
                    }
                    if (detail != null) {
                        OutlinedButton(onClick = {
                            scope.launch {
                                runCatching { Api.setWatched(kind, id, item.progress?.watched != true) }
                                    .onFailure { Toast.makeText(ctx, it.message, Toast.LENGTH_SHORT).show() }
                                refresh++
                            }
                        }) { Text(if (item.progress?.watched == true) "Unwatch" else "Watched") }
                    }
                }

                // Download
                when (download?.state) {
                    Download.STATE_COMPLETED -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Icon(painterResource(R.drawable.ic_downloaded), null, tint = Green)
                        Text("On this device · ${fmtSize(download.bytesDownloaded)}", color = Green, modifier = Modifier.weight(1f))
                        IconButton(onClick = { Downloads.remove(ctx, kind, id) }) { Icon(Icons.Default.Delete, "Delete download") }
                    }
                    Download.STATE_DOWNLOADING, Download.STATE_QUEUED, Download.STATE_RESTARTING -> Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(if (download.state == Download.STATE_QUEUED) "Waiting to download${if (Prefs.wifiOnly) " (Wi-Fi only)" else ""}…"
                                else "Downloading ${download.percentDownloaded.toInt().coerceAtLeast(0)}%", modifier = Modifier.weight(1f))
                            IconButton(onClick = { Downloads.remove(ctx, kind, id) }) { Icon(Icons.Default.Delete, "Cancel download") }
                        }
                        LinearProgressIndicator(progress = { (download.percentDownloaded / 100f).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                    }
                    else -> {
                        val pb = detail?.playback
                        val canDownload = pb?.download != null
                        // Opening this page doesn't start a conversion; asking for a download does.
                        val canPrepare = pb?.mode == "preparing" && (pb.state == null || pb.state == "none")
                        val pct = ((pb?.progress ?: 0.0) * 100).toInt()
                        OutlinedButton(
                            enabled = (canDownload || canPrepare) && !busy,
                            onClick = {
                                busy = true
                                scope.launch {
                                    if (canDownload) {
                                        runCatching { Downloads.start(ctx, detail!!) }
                                            .onFailure { Toast.makeText(ctx, it.message, Toast.LENGTH_LONG).show() }
                                    } else {
                                        runCatching { Api.prepare(kind, id, soon = true) }
                                            .onSuccess { Toast.makeText(ctx, "Preparing on the server — Download is ready when it's done", Toast.LENGTH_LONG).show() }
                                            .onFailure { Toast.makeText(ctx, it.message, Toast.LENGTH_LONG).show() }
                                        refresh++
                                    }
                                    busy = false
                                }
                            },
                        ) {
                            Icon(painterResource(R.drawable.ic_download), null); Spacer(Modifier.width(6.dp))
                            Text(
                                when {
                                    download?.state == Download.STATE_FAILED -> "Download failed — retry"
                                    canDownload -> "Download" + (pb?.download?.size?.let { " (${fmtSize(it)})" } ?: "")
                                    canPrepare -> "Prepare for download"
                                    pb?.mode == "preparing" && pb.state == "failed" -> "Couldn't prepare: ${pb.error ?: "failed"}"
                                    pb?.mode == "preparing" && pb.waiting?.reason == "space" -> "Server disk nearly full — waiting for room"
                                    pb?.mode == "preparing" && pb.state == "queued" -> "Waiting to prepare…"
                                    pb?.mode == "preparing" -> "Preparing for download… $pct%"
                                    pb?.mode == "hls" -> "Download once converted ($pct%)"
                                    else -> "Not available offline"
                                }
                            )
                        }
                    }
                }
                item.overview?.let { Text(it, color = Muted) }
                detail?.next?.let { n ->
                    Spacer(Modifier.height(4.dp))
                    Text("Up next: ${n.code} · ${n.title}", color = Muted, fontSize = 13.sp)
                }
            }
        }
    }
}

fun fmtTime(s: Double): String {
    val t = s.toInt()
    val h = t / 3600; val m = (t / 60) % 60; val sec = t % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}

// ─── Downloads ────────────────────────────────────────────────────────────────

@Composable
fun DownloadsTab(openItem: (Item) -> Unit) {
    val ctx = LocalContext.current
    var list by remember { mutableStateOf(Downloads.all()) }
    var wifiOnly by remember { mutableStateOf(Prefs.wifiOnly) }
    LaunchedEffect(Unit) { while (true) { list = Downloads.all(); delay(1000) } }

    Column {
        Row(Modifier.fillMaxWidth().padding(16.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Download over Wi-Fi only", modifier = Modifier.weight(1f))
            Switch(wifiOnly, { wifiOnly = it; Prefs.wifiOnly = it; Downloads.applyRequirements() })
        }
        if (list.isEmpty()) {
            Centered("Nothing downloaded. Open a movie or episode and tap Download.")
            return@Column
        }
        val total = list.filter { it.state == Download.STATE_COMPLETED }.sumOf { it.bytesDownloaded }
        Text("${list.size} item${if (list.size == 1) "" else "s"} · ${fmtSize(total)} on this device", color = Muted, fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = 16.dp))
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(list, key = { it.request.id }) { d ->
                val meta = Downloads.meta(d) ?: return@items
                val it0 = meta.item
                val local = ProgressStore.knownFor(it0.kind, it0.id)
                Row(
                    Modifier.fillMaxWidth().clickable {
                        if (d.state == Download.STATE_COMPLETED) PlayerActivity.start(ctx, it0.kind, it0.id) else openItem(it0)
                    },
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Artwork(it0.posterUrl, it0.heading, false, local?.let { p -> p.duration?.let { (p.position / it).toFloat() } } ?: 0f,
                        local?.watched == true, modifier = Modifier.width(56.dp))
                    Column(Modifier.weight(1f)) {
                        Text(it0.heading, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (it0.subheading.isNotEmpty()) Text(it0.subheading, color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            when (d.state) {
                                Download.STATE_COMPLETED -> fmtSize(d.bytesDownloaded)
                                Download.STATE_DOWNLOADING -> "Downloading ${d.percentDownloaded.toInt().coerceAtLeast(0)}% · ${fmtSize(d.bytesDownloaded)}"
                                Download.STATE_QUEUED -> if (Prefs.wifiOnly) "Waiting for Wi-Fi" else "Queued"
                                Download.STATE_FAILED -> "Failed — open it to retry"
                                else -> "Paused"
                            },
                            color = if (d.state == Download.STATE_COMPLETED) Muted else Accent, fontSize = 12.sp,
                        )
                    }
                    if (d.state == Download.STATE_COMPLETED) Icon(Icons.Default.PlayArrow, "Play", tint = Accent)
                    IconButton(onClick = { Downloads.remove(ctx, it0.kind, it0.id) }) { Icon(Icons.Default.Delete, "Delete", Modifier.size(20.dp)) }
                }
            }
        }
    }
}
