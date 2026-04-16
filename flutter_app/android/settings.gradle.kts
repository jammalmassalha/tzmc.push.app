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
        google()
        mavenCentral()
        gradlePluginPortal()
        // Fallback mirrors for corporate networks with SSL issues
        maven {
            url = uri("https://maven.aliyun.com/repository/google")
            isAllowInsecureProtocol = false
        }
        maven {
            url = uri("https://maven.aliyun.com/repository/central")
            isAllowInsecureProtocol = false
        }
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    // Using AGP 8.1.0 which is compatible with connectivity_plus and other Flutter plugins
    id("com.android.application") version "8.1.0" apply false
    id("org.jetbrains.kotlin.android") version "1.9.20" apply false
}

include(":app")