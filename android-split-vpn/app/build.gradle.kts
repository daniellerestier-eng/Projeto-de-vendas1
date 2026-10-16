plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.splitshield"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.splitshield"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // Galaxy S25 FE = arm64-v8a. x86_64 só para emulador.
        ndk {
            abiFilters.addAll(listOf("arm64-v8a", "x86_64"))
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Assina com a chave debug para que "Build APK" gere algo instalável direto.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // A biblioteca tunnel do WireGuard exige desugaring.
        isCoreLibraryDesugaringEnabled = true
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Túnel WireGuard oficial (ChaCha20-Poly1305, Curve25519) rodando em VpnService.
    implementation("com.wireguard.android:tunnel:1.0.20230706")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.0.4")

    testImplementation("junit:junit:4.13.2")
}
