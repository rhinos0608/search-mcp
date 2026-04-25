use std::fmt;

pub struct SampleService {
    prefix: String,
}

impl SampleService {
    pub fn new(prefix: String) -> Self {
        Self { prefix }
    }

    pub fn label(&self, name: &str) -> String {
        format_name(&self.prefix, name)
    }
}

pub fn format_name(prefix: &str, name: &str) -> String {
    let trimmed = name.trim().to_lowercase();
    format!("{}:{}", prefix, trimmed)
}

pub fn build_greeting(name: &str) -> String {
    format_name("hello", name)
}

fn helper() -> String {
    fmt::format(format_args!("{}", "ok")).to_string()
}
