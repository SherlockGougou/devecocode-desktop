//! 系统字体枚举。
//!
//! 设置页只允许从本机已安装字体中选择，避免用户输入拼写错误后静默回退。
//! macOS 使用 CoreText 的字体家族列表；返回的是显示名称，可直接作为
//! CSS `font-family` 使用。

use std::collections::BTreeSet;

/// 返回本机可供界面选择的字体家族名称。
pub fn available_font_families() -> anyhow::Result<Vec<String>> {
    #[cfg(target_os = "macos")]
    {
        macos::available_font_families()
    }

    #[cfg(not(target_os = "macos"))]
    {
        anyhow::bail!("当前平台不支持枚举系统字体")
    }
}

fn normalize_font_families(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let families = names
        .into_iter()
        .filter_map(|name| {
            let name = name.trim();
            // 点号开头的是 CoreText 内部字体，不应显示给用户选择。
            if name.is_empty() || name.starts_with('.') {
                None
            } else {
                Some(name.to_owned())
            }
        })
        .collect::<BTreeSet<_>>();
    families.into_iter().collect()
}

#[cfg(target_os = "macos")]
mod macos {
    use super::normalize_font_families;
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> CFArrayRef;
    }

    pub fn available_font_families() -> anyhow::Result<Vec<String>> {
        // Copy 规则：调用方持有返回值，由 CFArray 的 Drop 释放。
        let raw = unsafe { CTFontManagerCopyAvailableFontFamilyNames() };
        if raw.is_null() {
            anyhow::bail!("CoreText 未返回字体列表");
        }
        let families: CFArray<CFString> = unsafe { CFArray::wrap_under_create_rule(raw) };
        let names = families
            .iter()
            .map(|family| family.to_string())
            .collect::<Vec<_>>();
        Ok(normalize_font_families(names))
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_font_families;

    #[test]
    fn 字体名称去重并过滤空值() {
        let families = normalize_font_families(
            [" PingFang SC ", "PingFang SC", "", ".Hidden", "SF Mono"]
                .into_iter()
                .map(str::to_owned),
        );
        assert_eq!(families, vec!["PingFang SC", "SF Mono"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn 能读取本机字体家族() {
        let families = super::available_font_families().expect("CoreText 应能返回字体列表");
        assert!(!families.is_empty());
        assert!(families.iter().all(|family| !family.trim().is_empty()));
    }
}
