//! macOS 本地语音输入。
//!
//! ObjC 对象不跨线程移动：权限检查完成后创建专用工作线程，由线程内部持有
//! `SFSpeechRecognizer`、`AVAudioEngine` 和识别任务。Tauri 命令只发送停止/取消
//! 指令，识别结果转换成拥有所有权的 Rust 数据后通过事件发给前端。

use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2::runtime::Bool as ObjcBool;
use objc2::{sel, AnyThread, ClassType};
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_avf_audio::{AVAudioEngine, AVAudioInputNode, AVAudioPCMBuffer, AVAudioTime};
use objc2_foundation::{NSError, NSLocale, NSString};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
    SFSpeechRecognitionTaskHint, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};
use serde::{Deserialize, Serialize};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::ipc::SettingsState;

const AUTO_STOP_AFTER: Duration = Duration::from_secs(55);
const FINAL_RESULT_TIMEOUT: Duration = Duration::from_secs(8);
const PERMISSION_TIMEOUT: Duration = Duration::from_secs(120);
const START_TIMEOUT: Duration = Duration::from_secs(6);
const VOICE_EVENT: &str = "deveco://voice";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionState {
    NotDetermined,
    Authorized,
    Denied,
    Restricted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub microphone: PermissionState,
    pub speech: PermissionState,
    pub active: bool,
    pub starting: bool,
    pub session_id: Option<u64>,
    pub locale: Option<String>,
    pub system_locale: String,
    pub on_device: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceLocale {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStartResult {
    pub session_id: u64,
    pub locale: String,
    pub max_duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCommandError {
    pub code: String,
    pub message: String,
}

impl VoiceCommandError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Manual,
    Limit,
    Silence,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum VoiceEventKind {
    Partial,
    Finalizing,
    Final,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceEventPayload {
    #[serde(rename = "type")]
    kind: VoiceEventKind,
    session_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<FinishReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_partial: Option<String>,
}

fn partial(session_id: u64, text: String) -> VoiceEventPayload {
    VoiceEventPayload {
        kind: VoiceEventKind::Partial,
        session_id,
        text: Some(text),
        reason: None,
        code: None,
        message: None,
        last_partial: None,
    }
}

fn finalizing(session_id: u64, reason: FinishReason) -> VoiceEventPayload {
    VoiceEventPayload {
        kind: VoiceEventKind::Finalizing,
        session_id,
        text: None,
        reason: Some(reason),
        code: None,
        message: None,
        last_partial: None,
    }
}

fn final_result(session_id: u64, text: String, reason: FinishReason) -> VoiceEventPayload {
    VoiceEventPayload {
        kind: VoiceEventKind::Final,
        session_id,
        text: Some(text),
        reason: Some(reason),
        code: None,
        message: None,
        last_partial: None,
    }
}

fn error_result(
    session_id: u64,
    code: impl Into<String>,
    message: impl Into<String>,
    last_partial: Option<String>,
) -> VoiceEventPayload {
    VoiceEventPayload {
        kind: VoiceEventKind::Error,
        session_id,
        text: None,
        reason: None,
        code: Some(code.into()),
        message: Some(message.into()),
        last_partial,
    }
}

enum SessionCommand {
    Stop,
    Cancel,
}

struct ActiveSession {
    session_id: u64,
    locale: String,
    commands: mpsc::Sender<SessionCommand>,
}

#[derive(Default)]
struct VoiceInner {
    starting: Option<u64>,
    active: Option<ActiveSession>,
}

struct VoiceShared {
    inner: Mutex<VoiceInner>,
    next_session: AtomicU64,
}

impl Default for VoiceShared {
    fn default() -> Self {
        Self {
            inner: Mutex::new(VoiceInner::default()),
            next_session: AtomicU64::new(1),
        }
    }
}

impl VoiceShared {
    fn reserve_start(&self) -> Result<u64, VoiceCommandError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| VoiceCommandError::new("internal", "语音状态锁不可用"))?;
        if inner.starting.is_some() || inner.active.is_some() {
            return Err(VoiceCommandError::new(
                "busy",
                "语音输入正在使用中，请稍后再试",
            ));
        }
        let session_id = self.next_session.fetch_add(1, Ordering::Relaxed);
        inner.starting = Some(session_id);
        Ok(session_id)
    }

    fn activate_start(
        &self,
        session_id: u64,
        locale: String,
        commands: mpsc::Sender<SessionCommand>,
    ) -> Result<(), VoiceCommandError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| VoiceCommandError::new("internal", "语音状态锁不可用"))?;
        if inner.starting != Some(session_id) {
            return Err(VoiceCommandError::new("cancelled", "语音输入已取消"));
        }
        inner.starting = None;
        inner.active = Some(ActiveSession {
            session_id,
            locale,
            commands,
        });
        Ok(())
    }

    fn clear_starting(&self, session_id: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.starting == Some(session_id) {
                inner.starting = None;
            }
        }
    }

    fn finish(&self, session_id: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner
                .active
                .as_ref()
                .is_some_and(|session| session.session_id == session_id)
            {
                inner.active = None;
            }
        }
    }

    fn stop(&self) {
        if let Ok(inner) = self.inner.lock() {
            if let Some(session) = &inner.active {
                let _ = session.commands.send(SessionCommand::Stop);
            }
        }
    }

    fn cancel(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.starting = None;
            if let Some(session) = &inner.active {
                let _ = session.commands.send(SessionCommand::Cancel);
            }
        }
    }

    fn snapshot(&self) -> (bool, bool, Option<u64>, Option<String>) {
        let Ok(inner) = self.inner.lock() else {
            return (false, false, None, None);
        };
        (
            inner.active.is_some(),
            inner.starting.is_some(),
            inner.active.as_ref().map(|session| session.session_id),
            inner.active.as_ref().map(|session| session.locale.clone()),
        )
    }
}

#[derive(Default, Clone)]
pub struct VoiceState {
    shared: Arc<VoiceShared>,
}

impl VoiceState {
    pub fn cancel(&self) {
        self.shared.cancel();
    }
}

fn current_locale_identifier() -> String {
    NSLocale::currentLocale()
        .localeIdentifier()
        .to_string()
        .replace('_', "-")
}

fn preferred_locale_identifier() -> String {
    NSLocale::preferredLanguages()
        .iter()
        .next()
        .map(|value| value.to_string().replace('_', "-"))
        .unwrap_or_else(current_locale_identifier)
}

fn preferred_locale() -> objc2::rc::Retained<NSLocale> {
    NSLocale::preferredLanguages()
        .iter()
        .next()
        .map(|value| NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &value))
        .unwrap_or_else(NSLocale::currentLocale)
}

fn system_locale_candidates() -> Vec<String> {
    let mut values = Vec::new();
    for preferred in NSLocale::preferredLanguages().iter() {
        let locale = NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &preferred);
        values.push(locale.localeIdentifier().to_string());
        values.push(locale.languageIdentifier().to_string());
        let language = locale.languageCode().to_string();
        if let Some(region) = locale.regionCode() {
            values.push(format!("{language}-{region}"));
        }
    }
    let current = NSLocale::currentLocale();
    values.push(current.localeIdentifier().to_string());
    values.push(current.languageIdentifier().to_string());
    let language = current.languageCode().to_string();
    if let Some(region) = current.regionCode() {
        values.push(format!("{language}-{region}"));
    }
    let mut normalized: Vec<String> = values
        .into_iter()
        .map(|value| normalize_locale(&value))
        .collect();
    normalized.dedup();
    normalized
}

fn normalize_locale(value: &str) -> String {
    value.replace('_', "-").to_ascii_lowercase()
}

fn resolve_locale(
    preferred: Option<&str>,
    system_candidates: &[String],
    available: &[VoiceLocale],
) -> Option<String> {
    let candidates: Vec<String> = match preferred {
        Some(value) if !value.trim().is_empty() => vec![normalize_locale(value.trim())],
        _ => system_candidates.to_vec(),
    };
    for candidate in candidates {
        if let Some(locale) = available
            .iter()
            .find(|locale| normalize_locale(&locale.id) == candidate)
        {
            return Some(locale.id.clone());
        }
    }
    None
}

fn on_device_locales() -> Vec<VoiceLocale> {
    let display_locale = preferred_locale();
    let supported = unsafe { SFSpeechRecognizer::supportedLocales() };
    let mut locales = Vec::new();
    for locale in supported.iter() {
        let identifier = locale.localeIdentifier();
        let Some(recognizer) =
            (unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale) })
        else {
            continue;
        };
        if !unsafe { recognizer.supportsOnDeviceRecognition() } {
            continue;
        }
        let id = identifier.to_string().replace('_', "-");
        let label = display_locale
            .localizedStringForLocaleIdentifier(&identifier)
            .to_string();
        locales.push(VoiceLocale {
            id,
            label: if label.trim().is_empty() {
                "未知语言".to_string()
            } else {
                label
            },
        });
    }
    locales.sort_by(|left, right| {
        left.label
            .to_lowercase()
            .cmp(&right.label.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    locales.dedup_by(|left, right| normalize_locale(&left.id) == normalize_locale(&right.id));
    locales
}

fn speech_permission() -> PermissionState {
    match unsafe { SFSpeechRecognizer::authorizationStatus() } {
        SFSpeechRecognizerAuthorizationStatus::Authorized => PermissionState::Authorized,
        SFSpeechRecognizerAuthorizationStatus::Denied => PermissionState::Denied,
        SFSpeechRecognizerAuthorizationStatus::Restricted => PermissionState::Restricted,
        _ => PermissionState::NotDetermined,
    }
}

fn microphone_permission() -> PermissionState {
    let Some(media_type) = (unsafe { AVMediaTypeAudio }) else {
        return PermissionState::Restricted;
    };
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) } {
        AVAuthorizationStatus::Authorized => PermissionState::Authorized,
        AVAuthorizationStatus::Denied => PermissionState::Denied,
        AVAuthorizationStatus::Restricted => PermissionState::Restricted,
        _ => PermissionState::NotDetermined,
    }
}

fn request_speech_permission() -> Result<(), VoiceCommandError> {
    match speech_permission() {
        PermissionState::Authorized => return Ok(()),
        PermissionState::Denied => {
            return Err(VoiceCommandError::new(
                "speech_permission_denied",
                "语音识别权限已被拒绝，请到系统设置中允许",
            ));
        }
        PermissionState::Restricted => {
            return Err(VoiceCommandError::new(
                "speech_permission_restricted",
                "系统限制了语音识别权限",
            ));
        }
        PermissionState::NotDetermined => {}
    }

    let (sender, receiver) = mpsc::channel();
    let block = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
        let _ = sender.send(status);
    });
    unsafe { SFSpeechRecognizer::requestAuthorization(&block) };
    let status = receiver
        .recv_timeout(PERMISSION_TIMEOUT)
        .map_err(|_| VoiceCommandError::new("speech_permission_timeout", "等待语音识别授权超时"))?;
    match status {
        SFSpeechRecognizerAuthorizationStatus::Authorized => Ok(()),
        SFSpeechRecognizerAuthorizationStatus::Denied => Err(VoiceCommandError::new(
            "speech_permission_denied",
            "语音识别权限已被拒绝，请到系统设置中允许",
        )),
        SFSpeechRecognizerAuthorizationStatus::Restricted => Err(VoiceCommandError::new(
            "speech_permission_restricted",
            "系统限制了语音识别权限",
        )),
        _ => Err(VoiceCommandError::new(
            "speech_permission_denied",
            "语音识别权限不可用",
        )),
    }
}

fn request_microphone_permission() -> Result<(), VoiceCommandError> {
    match microphone_permission() {
        PermissionState::Authorized => return Ok(()),
        PermissionState::Denied => {
            return Err(VoiceCommandError::new(
                "microphone_permission_denied",
                "麦克风权限已被拒绝，请到系统设置中允许",
            ));
        }
        PermissionState::Restricted => {
            return Err(VoiceCommandError::new(
                "microphone_permission_restricted",
                "系统限制了麦克风权限",
            ));
        }
        PermissionState::NotDetermined => {}
    }

    let media_type = unsafe { AVMediaTypeAudio }
        .ok_or_else(|| VoiceCommandError::new("microphone_unavailable", "没有可用的麦克风"))?;
    let (sender, receiver) = mpsc::channel();
    let block = RcBlock::new(move |granted: ObjcBool| {
        let _ = sender.send(granted.as_bool());
    });
    unsafe {
        AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &block);
    }
    let granted = receiver.recv_timeout(PERMISSION_TIMEOUT).map_err(|_| {
        VoiceCommandError::new("microphone_permission_timeout", "等待麦克风授权超时")
    })?;
    if granted {
        Ok(())
    } else {
        Err(VoiceCommandError::new(
            "microphone_permission_denied",
            "麦克风权限已被拒绝，请到系统设置中允许",
        ))
    }
}

fn prepare_voice(preferred: Option<String>) -> Result<String, VoiceCommandError> {
    let locales = on_device_locales();
    if locales.is_empty() {
        return Err(VoiceCommandError::new(
            "on_device_unavailable",
            "这台 Mac 还没有可用的本地语音识别语言",
        ));
    }
    let candidates = system_locale_candidates();
    let locale = resolve_locale(preferred.as_deref(), &candidates, &locales).ok_or_else(|| {
        let requested = preferred.unwrap_or_else(preferred_locale_identifier);
        VoiceCommandError::new(
            "locale_unavailable",
            format!("{requested} 没有可用的本地语音识别资源，请在设置中选择其他语言"),
        )
    })?;
    request_speech_permission()?;
    request_microphone_permission()?;
    Ok(locale)
}

enum CallbackEvent {
    Result { text: String, is_final: bool },
    Error { domain: String, code: isize },
}

struct NativeSession {
    engine: objc2::rc::Retained<AVAudioEngine>,
    input: objc2::rc::Retained<AVAudioInputNode>,
    request: objc2::rc::Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: objc2::rc::Retained<SFSpeechRecognitionTask>,
    _recognizer: objc2::rc::Retained<SFSpeechRecognizer>,
    _result_block: RcBlock<dyn Fn(*mut SFSpeechRecognitionResult, *mut NSError)>,
    _tap_block: RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)>,
    tap_installed: bool,
    stopped: bool,
}

impl NativeSession {
    fn start(
        locale_id: &str,
        callback_tx: mpsc::Sender<CallbackEvent>,
    ) -> Result<Self, VoiceCommandError> {
        let ns_locale =
            NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &NSString::from_str(locale_id));
        let recognizer =
            unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &ns_locale) }
                .ok_or_else(|| {
                    VoiceCommandError::new("locale_unavailable", "当前语言不支持语音识别")
                })?;
        if !unsafe { recognizer.supportsOnDeviceRecognition() } {
            return Err(VoiceCommandError::new(
                "on_device_unavailable",
                "当前语言没有安装本地语音识别资源",
            ));
        }
        if !unsafe { recognizer.isAvailable() } {
            return Err(VoiceCommandError::new(
                "speech_unavailable",
                "系统语音识别服务暂时不可用",
            ));
        }

        let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
        unsafe {
            request.setShouldReportPartialResults(true);
            request.setRequiresOnDeviceRecognition(true);
            // addsPunctuation 从 macOS 13 才有，向 macOS 12 发送未知 selector 会崩溃。
            if SFSpeechAudioBufferRecognitionRequest::class().responds_to(sel!(setAddsPunctuation:))
            {
                request.setAddsPunctuation(true);
            }
            request.setTaskHint(SFSpeechRecognitionTaskHint::Dictation);
        }

        let result_block = RcBlock::new(
            move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                autoreleasepool(|_| {
                    if let Some(result) = unsafe { result.as_ref() } {
                        let text =
                            unsafe { result.bestTranscription().formattedString().to_string() };
                        let is_final = unsafe { result.isFinal() };
                        let _ = callback_tx.send(CallbackEvent::Result { text, is_final });
                    }
                    if let Some(error) = unsafe { error.as_ref() } {
                        let _ = callback_tx.send(CallbackEvent::Error {
                            domain: error.domain().to_string(),
                            code: error.code(),
                        });
                    }
                });
            },
        );
        let task =
            unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &result_block) };

        let engine = unsafe { AVAudioEngine::new() };
        let input = unsafe { engine.inputNode() };
        let format = unsafe { input.outputFormatForBus(0) };
        if unsafe { format.channelCount() } == 0 || unsafe { format.sampleRate() } <= 0.0 {
            unsafe { task.cancel() };
            return Err(VoiceCommandError::new(
                "microphone_unavailable",
                "没有检测到可用的麦克风输入",
            ));
        }

        let request_for_tap = request.clone();
        let tap_block = RcBlock::new(
            move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
                autoreleasepool(|_| {
                    let buffer = unsafe { buffer.as_ref() };
                    unsafe { request_for_tap.appendAudioPCMBuffer(buffer) };
                });
            },
        );
        unsafe {
            input.installTapOnBus_bufferSize_format_block(
                0,
                1024,
                Some(&format),
                RcBlock::as_ptr(&tap_block),
            );
            engine.prepare();
        }
        if let Err(error) = unsafe { engine.startAndReturnError() } {
            unsafe {
                input.removeTapOnBus(0);
                task.cancel();
            }
            log::warn!("语音引擎启动失败：{}（{}）", error.code(), error.domain());
            return Err(VoiceCommandError::new(
                "audio_start_failed",
                "无法启动麦克风录音",
            ));
        }

        Ok(Self {
            engine,
            input,
            request,
            task,
            _recognizer: recognizer,
            _result_block: result_block,
            _tap_block: tap_block,
            tap_installed: true,
            stopped: false,
        })
    }

    fn stop_audio(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        unsafe {
            self.engine.stop();
            if self.tap_installed {
                self.input.removeTapOnBus(0);
                self.tap_installed = false;
            }
            self.request.endAudio();
            self.task.finish();
        }
    }

    fn cancel(&mut self) {
        if self.stopped {
            unsafe { self.task.cancel() };
            return;
        }
        self.stopped = true;
        unsafe {
            self.engine.stop();
            if self.tap_installed {
                self.input.removeTapOnBus(0);
                self.tap_installed = false;
            }
            self.request.endAudio();
            self.task.cancel();
        }
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        if !self.stopped {
            self.cancel();
        }
    }
}

fn emit(app: &AppHandle, payload: VoiceEventPayload) {
    if let Err(error) = app.emit(VOICE_EVENT, payload) {
        log::warn!("广播语音事件失败：{error}");
    }
}

fn error_from_native(domain: &str, code: isize) -> VoiceCommandError {
    match (domain, code) {
        ("kLSRErrorDomain", 102) => VoiceCommandError::new(
            "on_device_unavailable",
            "本地语音识别资源未安装，请先在系统键盘设置中启用听写",
        ),
        ("kLSRErrorDomain", 201) => VoiceCommandError::new(
            "speech_disabled",
            "系统听写或 Siri 已关闭，请先在系统设置中启用",
        ),
        ("kLSRErrorDomain", 301) => VoiceCommandError::new("cancelled", "语音识别已取消"),
        ("kAFAssistantErrorDomain", 1110) => VoiceCommandError::new("no_speech", "没有识别到语音"),
        ("kAFAssistantErrorDomain", 1700) => {
            VoiceCommandError::new("speech_permission_denied", "语音识别权限不可用")
        }
        ("kAFAssistantErrorDomain", 1100) => {
            VoiceCommandError::new("recognizer_busy", "另一个语音识别任务仍在运行，请稍后重试")
        }
        ("kAFAssistantErrorDomain", 1101 | 1107) => {
            VoiceCommandError::new("recognizer_interrupted", "系统语音识别服务已中断，请重试")
        }
        _ => VoiceCommandError::new("recognition_failed", "语音识别失败，请重试"),
    }
}

fn run_session(
    app: AppHandle,
    shared: Arc<VoiceShared>,
    session_id: u64,
    locale_id: String,
    command_rx: mpsc::Receiver<SessionCommand>,
    ready_tx: mpsc::SyncSender<Result<(), VoiceCommandError>>,
) {
    let result = catch_unwind(AssertUnwindSafe(|| {
        run_session_inner(&app, session_id, &locale_id, command_rx, ready_tx);
    }));
    if result.is_err() {
        log::error!("语音工作线程异常退出");
        emit(
            &app,
            error_result(session_id, "internal", "语音输入异常退出，请重试", None),
        );
    }
    shared.finish(session_id);
}

fn run_session_inner(
    app: &AppHandle,
    session_id: u64,
    locale_id: &str,
    command_rx: mpsc::Receiver<SessionCommand>,
    ready_tx: mpsc::SyncSender<Result<(), VoiceCommandError>>,
) {
    let (callback_tx, callback_rx_inner) = mpsc::channel();
    let mut session = match NativeSession::start(locale_id, callback_tx) {
        Ok(session) => session,
        Err(error) => {
            let _ = ready_tx.send(Err(error));
            return;
        }
    };
    if ready_tx.send(Ok(())).is_err() {
        session.cancel();
        return;
    }

    let deadline = Instant::now() + AUTO_STOP_AFTER;
    let mut finish_reason: Option<FinishReason> = None;
    let mut final_deadline: Option<Instant> = None;
    let mut last_text = String::new();
    let mut last_emitted = String::new();

    loop {
        while let Ok(event) = callback_rx_inner.try_recv() {
            match event {
                CallbackEvent::Result { text, is_final } => {
                    last_text = text;
                    if !last_text.is_empty() && last_text != last_emitted {
                        last_emitted = last_text.clone();
                        emit(app, partial(session_id, last_text.clone()));
                    }
                    if is_final {
                        let reason = finish_reason.unwrap_or(FinishReason::Silence);
                        if finish_reason.is_none() {
                            emit(app, finalizing(session_id, reason));
                            session.stop_audio();
                        }
                        let text = last_text.trim().to_string();
                        if text.is_empty() {
                            emit(
                                app,
                                error_result(session_id, "no_speech", "没有识别到语音", None),
                            );
                        } else {
                            emit(app, final_result(session_id, text, reason));
                        }
                        return;
                    }
                }
                CallbackEvent::Error { domain, code } => {
                    let error = error_from_native(&domain, code);
                    log::warn!("语音识别失败：{domain}/{code} · {}", error.code);
                    session.cancel();
                    emit(
                        app,
                        error_result(session_id, error.code, error.message, non_empty(&last_text)),
                    );
                    return;
                }
            }
        }

        if finish_reason.is_none() {
            if Instant::now() >= deadline {
                finish_reason = Some(FinishReason::Limit);
                emit(app, finalizing(session_id, FinishReason::Limit));
                session.stop_audio();
                final_deadline = Some(Instant::now() + FINAL_RESULT_TIMEOUT);
                continue;
            }
            match command_rx.recv_timeout(Duration::from_millis(80)) {
                Ok(SessionCommand::Stop) => {
                    finish_reason = Some(FinishReason::Manual);
                    emit(app, finalizing(session_id, FinishReason::Manual));
                    session.stop_audio();
                    final_deadline = Some(Instant::now() + FINAL_RESULT_TIMEOUT);
                }
                Ok(SessionCommand::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    session.cancel();
                    return;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        } else {
            if final_deadline.is_some_and(|value| Instant::now() >= value) {
                session.cancel();
                emit(
                    app,
                    error_result(
                        session_id,
                        "timeout",
                        "语音识别没有及时完成，请重试",
                        non_empty(&last_text),
                    ),
                );
                return;
            }
            match command_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(SessionCommand::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    session.cancel();
                    return;
                }
                Ok(SessionCommand::Stop) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }

        while let Ok(event) = callback_rx_inner.try_recv() {
            match event {
                CallbackEvent::Result { text, is_final } => {
                    last_text = text;
                    if !last_text.is_empty() && last_text != last_emitted {
                        last_emitted = last_text.clone();
                        emit(app, partial(session_id, last_text.clone()));
                    }
                    if is_final {
                        let reason = finish_reason.unwrap_or(FinishReason::Silence);
                        if finish_reason.is_none() {
                            emit(app, finalizing(session_id, reason));
                            session.stop_audio();
                        }
                        let text = last_text.trim().to_string();
                        if text.is_empty() {
                            emit(
                                app,
                                error_result(session_id, "no_speech", "没有识别到语音", None),
                            );
                        } else {
                            emit(app, final_result(session_id, text, reason));
                        }
                        return;
                    }
                }
                CallbackEvent::Error { domain, code } => {
                    let error = error_from_native(&domain, code);
                    session.cancel();
                    emit(
                        app,
                        error_result(session_id, error.code, error.message, non_empty(&last_text)),
                    );
                    return;
                }
            }
        }
    }
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[tauri::command]
pub fn voice_status(state: tauri::State<'_, VoiceState>) -> VoiceStatus {
    let locales = on_device_locales();
    let preferred = None;
    let locale = resolve_locale(preferred, &system_locale_candidates(), &locales);
    let (active, starting, session_id, active_locale) = state.shared.snapshot();
    VoiceStatus {
        microphone: microphone_permission(),
        speech: speech_permission(),
        active,
        starting,
        session_id,
        locale: active_locale.or(locale),
        system_locale: preferred_locale_identifier(),
        on_device: !locales.is_empty(),
    }
}

#[tauri::command]
pub async fn voice_locales() -> Result<Vec<VoiceLocale>, VoiceCommandError> {
    tauri::async_runtime::spawn_blocking(on_device_locales)
        .await
        .map_err(|error| VoiceCommandError::new("internal", format!("读取语音语言失败：{error}")))
}

#[tauri::command]
pub async fn voice_start(
    app: AppHandle,
    state: tauri::State<'_, VoiceState>,
    settings: tauri::State<'_, SettingsState>,
) -> Result<VoiceStartResult, VoiceCommandError> {
    let preferred = settings
        .config
        .lock()
        .map_err(|_| VoiceCommandError::new("internal", "配置锁不可用"))?
        .voice
        .locale
        .clone()
        .and_then(|value| {
            let value = value.trim().to_string();
            if value.is_empty() {
                None
            } else {
                Some(value)
            }
        });
    let session_id = state.shared.reserve_start()?;
    let prepared = tauri::async_runtime::spawn_blocking(move || prepare_voice(preferred)).await;
    let locale = match prepared {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            state.shared.clear_starting(session_id);
            return Err(error);
        }
        Err(error) => {
            state.shared.clear_starting(session_id);
            return Err(VoiceCommandError::new(
                "internal",
                format!("启动语音任务失败：{error}"),
            ));
        }
    };

    let (command_tx, command_rx) = mpsc::channel();
    state
        .shared
        .activate_start(session_id, locale.clone(), command_tx)?;

    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let shared = state.shared.clone();
    let app_for_thread = app.clone();
    let locale_for_thread = locale.clone();
    let thread = std::thread::Builder::new()
        .name("deveco-voice".to_string())
        .spawn(move || {
            run_session(
                app_for_thread,
                shared,
                session_id,
                locale_for_thread,
                command_rx,
                ready_tx,
            );
        });
    if let Err(error) = thread {
        state.shared.finish(session_id);
        return Err(VoiceCommandError::new(
            "internal",
            format!("创建语音线程失败：{error}"),
        ));
    }

    match ready_rx.recv_timeout(START_TIMEOUT) {
        Ok(Ok(())) => Ok(VoiceStartResult {
            session_id,
            locale,
            max_duration_ms: AUTO_STOP_AFTER.as_millis() as u64,
        }),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            state.shared.cancel();
            Err(VoiceCommandError::new(
                "audio_start_timeout",
                "麦克风启动超时，请重试",
            ))
        }
    }
}

#[tauri::command]
pub fn voice_stop(state: tauri::State<'_, VoiceState>) {
    state.shared.stop();
}

#[tauri::command]
pub fn voice_cancel(state: tauri::State<'_, VoiceState>) {
    state.shared.cancel();
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoicePrivacyTarget {
    Microphone,
    Speech,
}

#[tauri::command]
pub fn voice_open_privacy_settings(kind: VoicePrivacyTarget) -> Result<(), String> {
    let url = match kind {
        VoicePrivacyTarget::Microphone => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        VoicePrivacyTarget::Speech => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"
        }
    };
    let status = std::process::Command::new("open")
        .arg(url)
        .status()
        .map_err(|error| format!("打开系统设置失败：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("打开系统设置失败：{status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_匹配忽略大小写和下划线() {
        let available = vec![
            VoiceLocale {
                id: "zh-CN".into(),
                label: "中文（中国大陆）".into(),
            },
            VoiceLocale {
                id: "en-US".into(),
                label: "英语（美国）".into(),
            },
        ];
        assert_eq!(
            resolve_locale(Some("zh_cn"), &[], &available),
            Some("zh-CN".into())
        );
        assert_eq!(
            resolve_locale(None, &["en-us".into()], &available),
            Some("en-US".into())
        );
    }

    #[test]
    fn 指定语言不可用时不静默回退() {
        let available = vec![VoiceLocale {
            id: "en-US".into(),
            label: "英语（美国）".into(),
        }];
        assert_eq!(
            resolve_locale(Some("zh-CN"), &["en-US".into()], &available),
            None
        );
    }
}
