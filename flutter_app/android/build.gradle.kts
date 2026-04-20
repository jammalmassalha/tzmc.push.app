// Firebase Cloud Messaging — the Google Services Gradle plugin is published
// only to Google Maven (no Plugin Portal marker), so it must be loaded via
// a buildscript classpath rather than the settings plugins{} DSL. It is
// applied conditionally in `app/build.gradle.kts` (only when
// `app/google-services.json` is present) so existing CI / sample builds
// without the credential keep working.
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.google.gms:google-services:4.4.2")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
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

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
