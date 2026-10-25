# ONNX Runtime 的 JNI 会按类名反查 Java 类（ai.onnxruntime.TensorInfo 等）。
# release 包开了 R8 后这些类会被重命名/裁掉，JNI 里 GetMethodID 拿到 null 直接 SIGABRT
# （Abort message: 'JNI DETECTED ERROR IN APPLICATION: java_class == null'）。
# 必须在消费方（app）的混淆配置里保留整个包，直接崩溃是 catch 不住的。
-keep class ai.onnxruntime.** { *; }
-keepclassmembers class ai.onnxruntime.** { *; }
-dontwarn ai.onnxruntime.**
