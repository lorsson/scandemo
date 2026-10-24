Pod::Spec.new do |s|
  s.name           = 'ImageCore'
  s.version        = '0.1.0'
  s.summary        = 'Native C++ image processing core'
  s.description    = 'Shared C++ implementation of document filters for Android and iOS.'
  s.license        = 'MIT'
  s.author         = 'myapp'
  s.homepage       = 'https://example.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/../common"'
  }

  s.libraries = 'c++'

  s.source_files = '**/*.{h,m,mm,swift}', '../common/*.{h,hpp,cpp}'
end
