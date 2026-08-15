// All languages supported in the app
// To add a new language, add it here and in the LANG array
// And create a new translation file in the locales folder named [lang].ts
export type Language = 'en' | 'fr'
export const LANG: Language[] = ['en', 'fr']

// All texts inside the app
export interface Translations {
    YOINK_BUTTON : string,
    DONE_LABEL: string,
    TAGLINE: string,
    DOWNLOAD_LABEL: string,
    CHANGE_LANGUAGE_LABEL: string,
    QUIT: string,
    CANCEL: string,
    TRY_AGAIN: string,
    BACK: string,
    CHOOSE:string,
    DONE:string,
    ERROR:string,
    WARNING_WRONG_URL:string,
    PLATFORMS: string,
    PASTE_A_LINK: string,
    LINK_IN_YOUR_CLIPBOARD: string,
    FROM_YOUR_CLIPBOARD: string,
    TO_PASTE_IT: string,
    TO_YOINK_IT: string,
    PROCESSING: string,
    LINK_EXPIRED_GRABBING_A_NEW_ONE: string,
    STARTING_DOWNLOAD: string,
    YOINKED: string,
    FIND_YOUR_FILE_IN: string,
    HISTORY: string,
    WARMING_UP: string,
    FETCHING_VIDEO_INFO: string,
    BEST_QUALITY: string,
    AUDIO_ONLY: string,
    THEME: string,
    themes: {
        auto: string,
        light: string,
        dark: string
    }
}