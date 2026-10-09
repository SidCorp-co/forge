//! English words a sentence builds around a value it interpolates.

/// The indefinite article before `word`, by the letter rules of `articles.ts:articleFor` in contracts: a word
/// with no vowel letter is said letter by letter ("an ftp", "a gcs"), so it takes "an" when its first
/// letter's name begins with a vowel sound (A E F H I L M N O R S X); otherwise a word starting with a
/// vowel letter takes "an", except the few said with a consonant first ("a unix", "a user").
pub fn indefinite_article(word: &str) -> &'static str {
    let w = word.trim().to_ascii_lowercase();
    let Some(first) = w.chars().next() else {
        return "a";
    };
    if !w.chars().any(|c| "aeiouy".contains(c)) {
        return if "aefhilmnorsx".contains(first) {
            "an"
        } else {
            "a"
        };
    }
    if ["uni", "use", "usu", "uti", "ure", "uro", "eu", "one"]
        .iter()
        .any(|p| w.starts_with(p))
    {
        return "a";
    }
    if "aeiou".contains(first) {
        "an"
    } else {
        "a"
    }
}

#[cfg(test)]
mod tests {
    use super::indefinite_article;

    #[test]
    fn follows_the_sound_of_the_word() {
        let cases = [
            ("ftp", "an"),
            ("gcs", "a"),
            ("http", "an"),
            ("epodsystem", "an"),
            ("autoflow", "an"),
            ("storefront", "a"),
            ("unix", "a"),
            ("user", "a"),
            ("", "a"),
        ];
        for (word, article) in cases {
            assert_eq!(indefinite_article(word), article, "{word}");
        }
    }
}
