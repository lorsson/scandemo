cmake_minimum_required(VERSION 3.5.0)
project(image_core)

set(NATIVERENDER_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR})
include_directories(${NATIVERENDER_ROOT_PATH} ${NATIVERENDER_ROOT_PATH}/include)

# Shared, platform-independent kernel (also compiled into Android/iOS builds).
get_filename_component(REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../.." REALPATH)
set(IMAGE_CORE_COMMON_DIR "${REPO_ROOT}/modules/image-core/common")
message(STATUS "image_core common dir: ${IMAGE_CORE_COMMON_DIR}")

add_library(image_core SHARED
    napi_init.cpp
    ${IMAGE_CORE_COMMON_DIR}/image_core.cpp
)

target_include_directories(image_core PRIVATE ${IMAGE_CORE_COMMON_DIR})
target_compile_features(image_core PRIVATE cxx_std_17)

# NAPI runtime provided by the OpenHarmony/HarmonyOS sysroot.
target_link_libraries(image_core PUBLIC libace_napi.z.so)
