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
            url = uri("http://dl.google.com/dl/android/maven2/")
            @Suppress("DEPRECATION")
			isAllowInsecureProtocol = true
        }
        maven {
            url = uri("http://repo.maven.apache.org/maven2/")
            @Suppress("DEPRECATION")
			isAllowInsecureProtocol = true
        }
        maven {
            url = uri("http://plugins.gradle.org/m2/")
            @Suppress("DEPRECATION")
			isAllowInsecureProtocol = true
        }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "8.1.0" apply false // Downgraded version for better compatibility
    id("org.jetbrains.kotlin.android") version "1.9.20" apply false // Matches standard Flutter 3.x setups
}

include(":app")