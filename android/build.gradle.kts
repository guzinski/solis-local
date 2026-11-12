plugins {
    id("com.android.application") version "9.5.0" apply false
    // Match the Kotlin compiler already used by the local ONVIF build.
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
}
