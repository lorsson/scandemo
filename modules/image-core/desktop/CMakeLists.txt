cmake_minimum_required(VERSION 3.20)

# 桌面端（Windows / macOS / Linux）：共享算法 → 动态库（C ABI + JNI）+ 命令行工具
project(image_core_desktop LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

set(CORE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../common)
set(CORE_SOURCES
  ${CORE_DIR}/image_core.cpp
  ${CORE_DIR}/image_core_c.cpp
)
set(STB_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/stb)

option(IMAGE_CORE_BUILD_JNI "Build the JNI bridge into the shared library" ON)

# MinGW（WinLibs 是 POSIX threads 构建）默认依赖 libstdc++-6.dll /
# libwinpthread-1.dll；静态链接后 DLL 和 exe 可以单独拷走。
if(MINGW)
  set(IMAGE_CORE_STATIC_RUNTIME -static-libgcc -static-libstdc++ -static)
else()
  set(IMAGE_CORE_STATIC_RUNTIME "")
endif()

# ---- 动态库：Python(ctypes) / Java(JNI) / 桌面 UI 共用 ----
add_library(image_core SHARED ${CORE_SOURCES})
target_include_directories(image_core PUBLIC ${CORE_DIR})
target_compile_definitions(image_core PRIVATE IC_EXPORTS)
target_link_options(image_core PRIVATE ${IMAGE_CORE_STATIC_RUNTIME})
set_target_properties(image_core PROPERTIES
  OUTPUT_NAME image_core
  C_VISIBILITY_PRESET hidden
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES
)
# MinGW 默认给 DLL 加 lib 前缀（libimage_core.dll），JVM 的
# System.loadLibrary("image_core") 和下面 Python 的查找都按 image_core.dll 找。
if(WIN32)
  set_target_properties(image_core PROPERTIES PREFIX "")
endif()

# JNI 只需要头文件（jni.h 只是声明 + JNIEnv 函数表），不需要链接 libjvm。
# 因此不走 find_package(JNI)：它还会强制找到 libawt，在精简 JDK 上经常失败。
if(IMAGE_CORE_BUILD_JNI)
  set(_jni_root "")
  if(JAVA_HOME AND EXISTS "${JAVA_HOME}/include/jni.h")
    set(_jni_root "${JAVA_HOME}")
  elseif(DEFINED ENV{JAVA_HOME} AND EXISTS "$ENV{JAVA_HOME}/include/jni.h")
    set(_jni_root "$ENV{JAVA_HOME}")
  endif()

  set(_jni_dirs "")
  if(_jni_root)
    list(APPEND _jni_dirs "${_jni_root}/include")
    foreach(_sub linux darwin win32)
      if(EXISTS "${_jni_root}/include/${_sub}")
        list(APPEND _jni_dirs "${_jni_root}/include/${_sub}")
      endif()
    endforeach()
  else()
    find_package(JNI QUIET)
    if(JNI_FOUND)
      set(_jni_dirs ${JNI_INCLUDE_DIRS})
    endif()
  endif()

  if(_jni_dirs)
    target_sources(image_core PRIVATE jni/java_bridge.cpp)
    target_include_directories(image_core PRIVATE ${_jni_dirs})
    message(STATUS "JNI headers: ${_jni_dirs}")
  else()
    message(WARNING
      "jni.h not found (set JAVA_HOME or pass -DJAVA_HOME=...); "
      "the shared library will be built without Java bindings.")
  endif()
endif()

# ---- 命令行工具：Python / 脚本 / 桌面 UI 直接调用 ----
add_executable(imagecore cli/main.cpp ${CORE_SOURCES})
target_include_directories(imagecore PRIVATE ${CORE_DIR} ${STB_DIR})
target_link_options(imagecore PRIVATE ${IMAGE_CORE_STATIC_RUNTIME})
if(MSVC)
  target_compile_options(imagecore PRIVATE /O2)
else()
  target_compile_options(imagecore PRIVATE -O2)
endif()

# Windows：把「拖拽即可用」的批处理放到 exe 旁边（改脚本后重新 build 即会同步）
if(WIN32)
  add_custom_target(imagecore_drop_copy ALL
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${CMAKE_CURRENT_SOURCE_DIR}/win/imagecore-drop.cmd
            $<TARGET_FILE_DIR:imagecore>/imagecore-drop.cmd
    DEPENDS imagecore
    COMMENT "Copying imagecore-drop.cmd"
    VERBATIM)
endif()

# ---- 自检：ctest 或直接运行 ----
enable_testing()
add_executable(image_core_selftest tests/selftest.cpp ${CORE_SOURCES})
target_include_directories(image_core_selftest PRIVATE ${CORE_DIR} ${STB_DIR})
target_link_options(image_core_selftest PRIVATE ${IMAGE_CORE_STATIC_RUNTIME})
add_test(NAME image_core_selftest
  COMMAND image_core_selftest
          ${CMAKE_CURRENT_SOURCE_DIR}/../../../assets/sample_doc.jpg
)

install(TARGETS image_core imagecore
  RUNTIME DESTINATION bin
  LIBRARY DESTINATION lib
)
