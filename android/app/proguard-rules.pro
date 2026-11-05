# kotlinx.serialization: keep generated serializers for the API models.
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class com.automagnet.app.**$$serializer { *; }
-keepclassmembers class com.automagnet.app.** { *** Companion; }
-keepclasseswithmembers class com.automagnet.app.** { kotlinx.serialization.KSerializer serializer(...); }
