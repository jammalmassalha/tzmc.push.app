pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
       maven { 
            url = uri("http://maven.aliyun.com/repository/google") 
            isAllowInsecureProtocol = true // Added 'is'
        }
        maven { 
            url = uri("http://maven.aliyun.com/repository/gradle-plugin") 
            isAllowInsecureProtocol = true // Added 'is'
        }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    
    // Updated from 8.6.0 to 8.9.1 (required by androidx.activity:activity 1.12.x and androidx.core 1.18.x)
    id("com.android.application") version "8.9.1" apply false
    
    // Updated from 1.9.20 to 2.1.0
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false

    // Note: the Google Services plugin (com.google.gms.google-services) for
    // Firebase Cloud Messaging is intentionally NOT declared here. Google
    // does not publish a plugin marker for it on the Gradle Plugin Portal —
    // it lives only on Google Maven as `com.google.gms:google-services`.
    // We pull it in via a `buildscript { classpath ... }` block in the
    // project-level `build.gradle.kts` and apply it conditionally in
    // `app/build.gradle.kts` (only when google-services.json is present).
}

include(":app")