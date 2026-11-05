package com.automagnet.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.lifecycle.lifecycleScope
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import android.net.Uri
import com.automagnet.app.ui.AddScreen
import com.automagnet.app.ui.AmTheme
import com.automagnet.app.ui.Bg
import com.automagnet.app.ui.DetailScreen
import com.automagnet.app.ui.LoginScreen
import com.automagnet.app.ui.MainScreen
import com.automagnet.app.ui.ManageMovieScreen
import com.automagnet.app.ui.ManageNav
import com.automagnet.app.ui.ManageShowScreen
import com.automagnet.app.ui.PickScreen
import com.automagnet.app.ui.ShowScreen
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Download progress shows as a notification; without this permission
        // downloads still run, just silently.
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        setContent {
            AmTheme {
                Surface(Modifier.fillMaxSize(), color = Bg) {
                    val nav = rememberNavController()
                    val toLogin: () -> Unit = {
                        nav.navigate("login") { popUpTo(0) { inclusive = true } }
                    }
                    NavHost(nav, startDestination = if (Prefs.token != null) "main" else "login") {
                        composable("login") {
                            LoginScreen(onDone = { nav.navigate("main") { popUpTo(0) { inclusive = true } } })
                        }
                        val openPick: (PickFor) -> Unit = { p ->
                            nav.navigate(
                                "pick/${p.type}/${p.tmdbId}/${p.mediaId}/${p.quality}?title=${Uri.encode(p.title)}" +
                                    "&season=${p.season ?: -1}&episode=${p.episode ?: -1}&ep=${p.episodeId ?: -1}"
                            )
                        }
                        val openManaged: (String, Int) -> Unit = { type, id -> nav.navigate("manage/$type/$id") }
                        composable("main") {
                            MainScreen(
                                openItem = { nav.navigate("item/${it.kind}/${it.id}") },
                                openShow = { nav.navigate("show/$it") },
                                manage = ManageNav(
                                    movie = { openManaged("movie", it) },
                                    show = { openManaged("show", it) },
                                    add = { nav.navigate("manage/add") },
                                    pick = openPick,
                                ),
                                onSignOut = toLogin,
                                onAuth = toLogin,
                            )
                        }
                        composable("manage/add") {
                            // Once added, open it in place of the search.
                            AddScreen(back = { nav.popBackStack() }, onAuth = toLogin, added = { type, id ->
                                nav.navigate("manage/$type/$id") { popUpTo("manage/add") { inclusive = true } }
                            })
                        }
                        composable("manage/movie/{id}", listOf(navArgument("id") { type = NavType.IntType })) { e ->
                            ManageMovieScreen(e.arguments!!.getInt("id"), back = { nav.popBackStack() }, openPick = openPick, onAuth = toLogin)
                        }
                        composable("manage/show/{id}", listOf(navArgument("id") { type = NavType.IntType })) { e ->
                            ManageShowScreen(e.arguments!!.getInt("id"), back = { nav.popBackStack() }, openPick = openPick, onAuth = toLogin)
                        }
                        composable(
                            "pick/{type}/{tmdb}/{media}/{quality}?title={title}&season={season}&episode={episode}&ep={ep}",
                            listOf(
                                navArgument("type") { type = NavType.StringType },
                                navArgument("tmdb") { type = NavType.IntType },
                                navArgument("media") { type = NavType.IntType },
                                navArgument("quality") { type = NavType.StringType },
                                navArgument("title") { type = NavType.StringType; defaultValue = "" },
                                navArgument("season") { type = NavType.IntType; defaultValue = -1 },
                                navArgument("episode") { type = NavType.IntType; defaultValue = -1 },
                                navArgument("ep") { type = NavType.IntType; defaultValue = -1 },
                            ),
                        ) { e ->
                            val a = e.arguments!!
                            val opt = { k: String -> a.getInt(k).takeIf { it >= 0 } }
                            PickScreen(
                                PickFor(a.getString("type")!!, a.getInt("tmdb"), a.getInt("media"), a.getString("title") ?: "",
                                    a.getString("quality")!!, opt("season"), opt("episode"), opt("ep")),
                                back = { nav.popBackStack() }, onAuth = toLogin,
                            )
                        }
                        composable("show/{id}", listOf(navArgument("id") { type = NavType.IntType })) { e ->
                            ShowScreen(e.arguments!!.getInt("id"), back = { nav.popBackStack() },
                                openItem = { nav.navigate("item/${it.kind}/${it.id}") }, onAuth = toLogin)
                        }
                        composable("item/{kind}/{id}", listOf(navArgument("kind") { type = NavType.StringType }, navArgument("id") { type = NavType.IntType })) { e ->
                            DetailScreen(e.arguments!!.getString("kind")!!, e.arguments!!.getInt("id"), back = { nav.popBackStack() }, onAuth = toLogin)
                        }
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Upload anything watched while offline as soon as the app is opened.
        lifecycleScope.launch { ProgressStore.sync() }
    }
}
