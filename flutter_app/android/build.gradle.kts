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
