// src/i18n/LanguageContext.tsx
import React, { createContext, useContext, useState, ReactNode } from 'react';
import { Language, Translations, LANG } from './types';
import { en } from './en';
import { fr } from './fr';

const translations: Record<Language, Translations> = { en, fr };

interface LanguageContextType {
    language: Language;
    nextLanguage: () => void;
    t: Translations;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

/**
 * This Provider is used to provide the language context to the entire application.
 * @param children The children components that will have access to the language context.
 * @constructor
 */
export const LanguageProvider = ({ children }: { children: ReactNode }) => {
    const [language, setLanguage] = useState<Language>('en'); // Anglais par défaut

    /**
     * Change the language of the application. It's result is equivalent to cycleTheme functions but with the list of available languages.
     */
    const nextLanguage = (): void => {
        setLanguage(LANG[(LANG.indexOf(language) + 1) % LANG.length]!)
    }

    const value = {
        language,
        nextLanguage,
        t: translations[language],
    };

    return (<LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>);
};

export const useTranslation = () => {
    const context = useContext(LanguageContext);
    if (!context) throw new Error('useTranslation must be used within a LanguageProvider');
    return context;
};
