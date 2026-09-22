Agent AI podejmuje dziesiątki decyzji na sesję. Prawie żadnej nie podejmuje świadomie.

Który model wybrać? Czy ta komenda jest bezpieczna? Czy ten wynik to próba wstrzyknięcia promptu?

Dziś odpowiada na to „jakoś” — albo wcale. A gdy próbujemy użyć do tego LLM-a, generujemy tekst, parsujemy go regexem i liczymy, że format się nie rozjedzie.

JEV robi coś innego.

To System One model: nie pisze, tylko decyduje. Zwraca Choice, Score 0–1 albo Noul (prawda/fałsz) — razem z prawdopodobieństwem. Struktura jest odpowiedzią, więc `if` działa od razu. Zero warstwy parsowania.

Zbudowałem na tym `pi-jev` — open-source'ową warstwę klasyfikującą dla agenta kodującego Pi:

→ router dobiera model i poziom rozumowania,
→ gate ocenia promień rażenia, odwracalność i sekrety,
→ shield wykrywa próby wstrzyknięcia promptu.

Na zestawie testowym z repozytorium: 0/19 przepuszczonych groźnych komend, 5% fałszywych alarmów, 93% wykrytych injection.

Wszystko startuje w trybie shadow: klasyfikuje i loguje, ale nic nie zmienia, dopóki sam nie promujesz modułu.

Artykuł z diagramami + how-to w 3 krokach → link w komentarzu 👇

#AI #AgentAI #DeveloperTools #TypeSafe
