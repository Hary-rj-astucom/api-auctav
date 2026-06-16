CREATE TABLE otp (
    id INT auto_increment PRIMARY KEY,
    email VARCHAR(50) NOT NULL,
    ip_adress VARCHAR(25) NOT NULL,
    source VARCHAR(25) NOT NULL,
    otp VARCHAR(20) NOT NULL,
    date_created TIMESTAMP default current_timestamp,
    expire_time INT default 180, -- 3 minutes
    state INT default 1 -- 1: actif; 2: expire
);

-- donnees de course denormalise
CREATE TABLE partant (
    id INT auto_increment PRIMARY KEY,
    nom VARCHAR(50) NOT NULL,
    naissance VARCHAR(25) NOT NULL,
    sexe VARCHAR(5) NOT NULL,
    pere VARCHAR(50) default NULL,
    mere VARCHAR(50) default NULL,
    discipline VARCHAR(25) default NULL,
    date DATE default NULL,
    course VARCHAR(10) NOT NULL,
    prix VARCHAR(180) NOT NULL,
    hippodrome VARCHAR(100) NOT NULL,
    distance VARCHAR(25) default NULL,
    record VARCHAR(10) default NULL,
    gains VARCHAR(25) default NULL,
    reduction VARCHAR(10) default NULL,
    reduction_date DATE default NULL,
    reduction_lieu VARCHAR(100) default NULL,
    urlPerfs VARCHAR(160) NOT NULL
);
ALTER TABLE partant
ADD CONSTRAINT uq_partant
UNIQUE (date, urlPerfs);

-- donnees d'engagement denormalise
CREATE TABLE engage (
    id INT auto_increment PRIMARY KEY,
    date DATE NOT NULL,
    nom VARCHAR(50) NOT NULL,
    naissance VARCHAR(25) NOT NULL,
    hippodrome VARCHAR(100) NOT NULL,
    lot VARCHAR(10) NOT NULL,
    reduction VARCHAR(10) default NULL,
    reduction_date DATE default NULL,
    discipline VARCHAR(25) default NULL,
    urlPerfs  VARCHAR(160) NOT NULL
);
ALTER TABLE engage
ADD CONSTRAINT uq_partant
UNIQUE (date, urlPerfs);


-- ----------------------------------------------------------------------------------------------------------------- --

SELECT DISTINCT(contact_id), nom, prenom, email, tel FROM `contact_infos` 
JOIN contact ON contact_infos.contact_id = contact.id
WHERE contact_type = 'infos_suppl' AND infos_cle like '%TRO%' OR infos_cle like '%tro%' AND infos_value LIKE "oui";