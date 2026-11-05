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
import com.automagnet.app.ui.AmTheme
import com.automagnet.app.ui.Bg
import com.automagnet.app.ui.DetailScreen
import com.automagnet.app.ui.LoginScreen
import com.automagnet.app.ui.MainScreen
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
                        composable("main") {
                            MainScreen(
                                openItem = { nav.navigate("item/${it.kind}/${it.id}") },
                                openShow = { nav.navigate("show/$it") },
                                onSignOut = toLogin,
                                onAuth = toLogin,
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
