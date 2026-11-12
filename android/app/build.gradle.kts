import groovy.json.JsonSlurper

plugins { id("com.android.application") }
val buildInfo = JsonSlurper().parse(rootProject.file("../public/build-info.json")) as Map<*, *>
android {
    namespace = "org.solislocal.app"
    compileSdk = 37
    defaultConfig {
        applicationId = "org.solislocal.app"
        minSdk = 28
        targetSdk = 36
        versionCode = (buildInfo["build"] as Number).toInt()
        versionName = buildInfo["version"] as String
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.2.0")
}
