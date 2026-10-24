import java.time.Duration

plugins {
    id("com.android.library")
    id("maven-publish")
}

group = "dev.indiasubscriptions"
version = "0.1.0"

android {
    namespace = "dev.indiasubscriptions"
    compileSdk = 36

    defaultConfig {
        // Play Billing Library 8.1 and later require minSdk 23.
        minSdk = 23
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        warningsAsErrors = true
        abortOnError = true
        checkDependencies = true
        // Both are suggestions, not defects: the versions are pinned on purpose (see the README), and the KTX
        // replacements (`toUri`, `SharedPreferences.edit`) would add androidx.core-ktx for a one-line convenience.
        disable += setOf("GradleDependency", "UseKtx")
    }

    testOptions {
        unitTests.all { it.timeout.set(Duration.ofMinutes(5)) }
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

kotlin {
    explicitApi()
    compilerOptions {
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    // Play Billing Library 9. The Java artifact only: the SDK wraps its callbacks itself, so the KTX artifact is not needed.
    implementation("com.android.billingclient:billing:9.1.0")
    // Custom Tabs for the hosted checkout page.
    implementation("androidx.browser:browser:1.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.2.20")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    // The Android platform's org.json is a stub in JVM unit tests.
    testImplementation("org.json:json:20260814")
}

afterEvaluate {
    publishing {
        publications {
            register<MavenPublication>("release") {
                from(components["release"])
                groupId = "dev.indiasubscriptions"
                artifactId = "android"
                version = project.version.toString()
            }
        }
    }
}
