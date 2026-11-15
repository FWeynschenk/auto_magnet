package com.automagnet.app

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory

class App : Application(), ImageLoaderFactory {
    // Pictures load through the app's own client, which signs requests to the
    // auto_magnet server (an episode's frame) and nothing else.
    override fun newImageLoader(): ImageLoader = ImageLoader.Builder(this).okHttpClient(Api.http).build()

    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        Downloads.init(this)
    }
}
