package com.automagnet.app

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        Downloads.init(this)
    }
}
