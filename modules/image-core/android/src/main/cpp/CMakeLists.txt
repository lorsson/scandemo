cmake_minimum_required(VERSION 3.22.1)

project(imagecore)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(IMAGE_CORE_COMMON_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../common)

add_library(image_core SHARED
  jni_bridge.cpp
  ${IMAGE_CORE_COMMON_DIR}/image_core.cpp
)

target_include_directories(image_core PRIVATE ${IMAGE_CORE_COMMON_DIR})

target_compile_options(image_core PRIVATE
  -O3
  -fvisibility=hidden
  -ffunction-sections
  -fdata-sections
)

target_link_options(image_core PRIVATE -Wl,--gc-sections)

find_library(log-lib log)
target_link_libraries(image_core ${log-lib} android)
