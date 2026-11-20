import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing: from signing.properties next to this project (never committed), or from the
// environment in CI (HEARTH_KEYSTORE, HEARTH_KEYSTORE_PASSWORD, HEARTH_KEY_ALIAS,
// HEARTH_KEY_PASSWORD). Without them, release builds are unsigned.
val signing = Properties().apply {
    val f = rootProject.file("signing.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun secret(name: String, env: String): String? = signing.getProperty(name) ?: System.getenv(env)

android {
    namespace = "com.dragonsoath.hearth"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dragonsoath.hearth"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("HEARTH_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("HEARTH_VERSION") ?: "0.0.1"
    }

    signingConfigs {
        val store = secret("storeFile", "HEARTH_KEYSTORE")
        if (store != null) {
            create("release") {
                storeFile = file(store)
                storePassword = secret("storePassword", "HEARTH_KEYSTORE_PASSWORD")
                keyAlias = secret("keyAlias", "HEARTH_KEY_ALIAS")
                keyPassword = secret("keyPassword", "HEARTH_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
